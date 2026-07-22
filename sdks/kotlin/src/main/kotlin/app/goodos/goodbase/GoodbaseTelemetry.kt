package app.goodos.goodbase

import android.app.Activity
import android.app.Application
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Bundle
import android.os.Debug
import android.os.Handler
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

enum class GoodbaseConsent { GRANTED, ESSENTIAL, DENIED }

data class GoodbaseTelemetryOptions(
    val appId: String,
    val release: String,
    val buildNumber: String,
    val distributionTrack: String? = null,
    val anrThresholdMs: Long = 5_000
)

class GoodbaseTelemetry private constructor(
    private val application: Application,
    private val client: GoodbaseClient,
    private val options: GoodbaseTelemetryOptions,
    consent: GoodbaseConsent
) : Application.ActivityLifecycleCallbacks {
    private val executor = Executors.newSingleThreadExecutor()
    private val sessionId = UUID.randomUUID().toString()
    private val store = GoodbaseTelemetryStore(application, options.appId)
    private val breadcrumbs = ArrayDeque<JSONObject>()
    private val customKeys = linkedMapOf<String, String>()
    private val started = AtomicBoolean(false)
    @Volatile private var consent = consent
    @Volatile private var foregroundActivities = 0
    private var previousHandler: Thread.UncaughtExceptionHandler? = null
    private var anrWatchdog: Thread? = null

    fun start() {
        if (consent == GoodbaseConsent.DENIED || !started.compareAndSet(false, true)) return
        application.registerActivityLifecycleCallbacks(this)
        previousHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            captureCrash(error, fatal = true, type = error.javaClass.name, synchronous = true)
            previousHandler?.uncaughtException(thread, error)
        }
        startAnrWatchdog()
        session("start")
        flush()
    }

    fun stop() {
        if (!started.compareAndSet(true, false)) return
        session("end", "normal")
        application.unregisterActivityLifecycleCallbacks(this)
        Thread.setDefaultUncaughtExceptionHandler(previousHandler)
        anrWatchdog?.interrupt()
    }

    fun setConsent(value: GoodbaseConsent) {
        consent = value
        if (value == GoodbaseConsent.DENIED) { store.clear(); stop() } else start()
    }

    @Synchronized fun breadcrumb(message: String, data: Map<String, Any?> = emptyMap()) {
        breadcrumbs.add(JSONObject().put("message", message.take(500)).put("data", JSONObject(data)).put("at", System.currentTimeMillis()))
        while (breadcrumbs.size > 50) breadcrumbs.removeFirst()
    }

    @Synchronized fun setCustomKey(key: String, value: Any?) {
        if (customKeys.containsKey(key) || customKeys.size < 64) customKeys[key.take(100)] = value.toString().take(1000)
    }

    fun captureException(error: Throwable) = captureCrash(error, false, error.javaClass.name)

    fun <T> trace(name: String, type: String = "custom", block: () -> T): T {
        val startedAt = System.nanoTime()
        try { return block() } catch (error: Throwable) { captureException(error); throw error }
        finally { send("trace", JSONObject().put("appId", options.appId).put("type", type).put("name", name.take(200)).put("durationMs", (System.nanoTime()-startedAt)/1_000_000.0).put("occurredAt", now())) }
    }

    fun flush() = executor.execute {
        if (consent == GoodbaseConsent.DENIED) return@execute
        val remaining = mutableListOf<JSONObject>()
        store.read().forEach { event -> try { upload(event) } catch (_: Exception) { remaining += event } }
        store.replace(remaining.takeLast(100))
        GoodbaseNativeCrash.consume(application.filesDir.absolutePath)?.let { marker ->
            send("crash", crashPayload("Native crash signal ${marker.optInt("signal")}", marker.toString(), true, "NDK"))
        }
    }

    private fun session(action: String, endedReason: String? = null) = send("session", JSONObject()
        .put("appId", options.appId).put("sessionId", sessionId).put("action", action)
        .put("consentState", consent.name.lowercase()).put("occurredAt", now())
        .put("release", options.release).put("buildNumber", options.buildNumber)
        .put("distributionTrack", options.distributionTrack).put("endedReason", endedReason))

    private fun captureCrash(error: Throwable, fatal: Boolean, type: String, synchronous: Boolean = false) {
        val payload = crashPayload(error.message ?: type, error.stackTraceToString(), fatal, type)
        if (synchronous) store.append(JSONObject().put("kind", "crash").put("payload", payload)) else send("crash", payload)
    }

    @Synchronized private fun crashPayload(title: String, stack: String, fatal: Boolean, type: String) = JSONObject()
        .put("appId", options.appId).put("platform", "android").put("occurredAt", now())
        .put("title", title.take(300)).put("stackTrace", stack.take(32_000)).put("sessionId", sessionId)
        .put("release", options.release).put("buildNumber", options.buildNumber).put("fatal", fatal)
        .put("exceptionType", type).put("breadcrumbs", JSONArray(breadcrumbs.toList()))
        .put("customKeys", JSONObject(customKeys as Map<*, *>)).put("device", JSONObject().put("sdk", android.os.Build.VERSION.SDK_INT).put("model", android.os.Build.MODEL))

    private fun send(kind: String, payload: JSONObject) {
        if (consent == GoodbaseConsent.DENIED) return
        executor.execute { val event = JSONObject().put("kind", kind).put("payload", payload); try { upload(event) } catch (_: Exception) { store.append(event) } }
    }

    private fun upload(event: JSONObject) { when(event.getString("kind")) {
        "session" -> client.recordSession(event.getJSONObject("payload").toString())
        "crash" -> client.captureCrash(event.getJSONObject("payload").toString())
        else -> client.recordTrace(event.getJSONObject("payload").toString())
    } }

    private fun startAnrWatchdog() {
        val main = Handler(Looper.getMainLooper()); val acknowledged = AtomicBoolean(true)
        anrWatchdog = Thread({ while (!Thread.currentThread().isInterrupted) { acknowledged.set(false); main.post { acknowledged.set(true) }; Thread.sleep(options.anrThresholdMs); if (!acknowledged.get() && !Debug.isDebuggerConnected()) captureCrash(RuntimeException("Main thread unresponsive"), false, "ANR") } }, "Goodbase-ANR").also { it.isDaemon=true; it.start() }
    }

    override fun onActivityStarted(activity: Activity) { if (++foregroundActivities == 1) session("foreground") }
    override fun onActivityStopped(activity: Activity) { if (--foregroundActivities == 0) session("background", "background") }
    override fun onActivityCreated(a: Activity, b: Bundle?) = Unit
    override fun onActivityResumed(a: Activity) = Unit
    override fun onActivityPaused(a: Activity) = Unit
    override fun onActivitySaveInstanceState(a: Activity, b: Bundle) = Unit
    override fun onActivityDestroyed(a: Activity) = Unit

    companion object {
        @Volatile private var instance: GoodbaseTelemetry? = null
        fun install(application: Application, client: GoodbaseClient, options: GoodbaseTelemetryOptions, consent: GoodbaseConsent = GoodbaseConsent.DENIED): GoodbaseTelemetry = synchronized(this) {
            instance ?: GoodbaseTelemetry(application, client, options, consent).also { instance=it; GoodbaseNativeCrash.install(application.filesDir.absolutePath); it.start() }
        }
        fun current(): GoodbaseTelemetry? = instance
        private fun now() = java.time.Instant.now().toString()
    }
}

class GoodbaseInitProvider : ContentProvider() {
    override fun onCreate(): Boolean = true
    override fun query(u: Uri, p: Array<out String>?, s: String?, a: Array<out String>?, o: String?): Cursor? = null
    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}

private class GoodbaseTelemetryStore(context: Context, appId: String) {
    private val file = File(context.filesDir, "goodbase-${appId.replace(Regex("[^A-Za-z0-9._-]"), "_")}.jsonl")
    @Synchronized fun append(event: JSONObject) { val rows=read().toMutableList();rows+=event;replace(rows.takeLast(100)) }
    @Synchronized fun read(): List<JSONObject> = if(!file.exists()) emptyList() else file.readLines().mapNotNull { runCatching { JSONObject(it) }.getOrNull() }
    @Synchronized fun replace(events: List<JSONObject>) { val temp=File(file.parentFile,"${file.name}.tmp");temp.writeText(events.joinToString("\n"));if(!temp.renameTo(file)){file.writeText(temp.readText());temp.delete()} }
    @Synchronized fun clear() { file.delete() }
}

private object GoodbaseNativeCrash {
    init { runCatching { System.loadLibrary("goodbase_crash") } }
    private external fun nativeInstall(path: String)
    fun install(path: String) = runCatching { nativeInstall(path) }.getOrNull()
    fun consume(path: String): JSONObject? { val file=File(path,"goodbase-native-crash.json");if(!file.exists())return null;val value=runCatching{JSONObject(file.readText())}.getOrNull();file.delete();return value }
}

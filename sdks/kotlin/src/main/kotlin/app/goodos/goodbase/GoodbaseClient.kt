package app.goodos.goodbase

import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

class GoodbaseClient(private val baseUrl: String = "https://base.goodos.app", var accessToken: String? = null, var attestationToken: String? = null) {
    fun request(path: String, method: String = "GET", jsonBody: String? = null): String {
        val connection=(URL(baseUrl.trimEnd('/')+path).openConnection() as HttpURLConnection).apply { requestMethod=method;connectTimeout=15000;readTimeout=30000;setRequestProperty("Accept","application/json");setRequestProperty("X-Request-ID",UUID.randomUUID().toString());accessToken?.let{setRequestProperty("Authorization","Bearer $it")};attestationToken?.let{setRequestProperty("X-Goodbase-Attestation",it)};if(jsonBody!=null){doOutput=true;setRequestProperty("Content-Type","application/json")} }
        try{if(jsonBody!=null)connection.outputStream.bufferedWriter(Charsets.UTF_8).use{it.write(jsonBody)};val status=connection.responseCode;val stream=if(status in 200..299)connection.inputStream else connection.errorStream;val payload=stream?.bufferedReader(Charsets.UTF_8)?.use{it.readText()}?:"{}";require(status in 200..299){"Goodbase request failed with $status"};return payload}finally{connection.disconnect()}
    }

    fun registerMessagingDevice(jsonBody: String): String =
        request("/api/goodbase/v1/growth/messaging/devices", "POST", jsonBody)

    fun createAttestationChallenge(jsonBody: String): String =
        request("/api/goodbase/v1/growth/attestation/challenge", "POST", jsonBody)

    fun exchangeAttestation(jsonBody: String): String =
        request("/api/goodbase/v1/growth/attestation/exchange", "POST", jsonBody)

    fun track(jsonBody: String): String = request("/api/goodbase/v1/product/analytics/events", "POST", jsonBody)
    fun recordSession(jsonBody: String): String = request("/api/goodbase/v1/product/telemetry/sessions", "POST", jsonBody)
    fun captureCrash(jsonBody: String): String = request("/api/goodbase/v1/product/telemetry/crashes", "POST", jsonBody)
    fun recordTrace(jsonBody: String): String = request("/api/goodbase/v1/product/telemetry/traces", "POST", jsonBody)
    fun remoteConfig(appId: String, query: String = ""): String = request("/api/goodbase/v1/product/config/$appId${if(query.isBlank())"" else "?$query"}")
    fun registerPushToken(jsonBody: String): String = request("/api/goodbase/v1/growth/messaging/devices", "POST", jsonBody)
    fun experimentAssignments(appId: String): String = request("/api/goodbase/v1/product/experiments/$appId/assignments")
}

import app.goodos.goodbase.GoodbaseClient

val goodbase = GoodbaseClient()

fun registerDevice(payload: String): String = goodbase.registerMessagingDevice(payload)


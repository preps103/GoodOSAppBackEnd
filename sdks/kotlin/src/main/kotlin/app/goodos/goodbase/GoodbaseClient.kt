package app.goodos.goodbase

import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.util.UUID

class GoodbaseClient(private val baseUrl: String = "https://base.goodos.app", var accessToken: String? = null) {
    private val http = HttpClient.newBuilder().build()
    fun request(path: String, method: String = "GET", jsonBody: String? = null): String {
        val builder = HttpRequest.newBuilder(URI.create(baseUrl.trimEnd('/') + path))
            .header("Accept", "application/json").header("X-Request-ID", UUID.randomUUID().toString())
        accessToken?.let { builder.header("Authorization", "Bearer $it") }
        if (jsonBody != null) builder.header("Content-Type", "application/json")
        builder.method(method, jsonBody?.let { HttpRequest.BodyPublishers.ofString(it) } ?: HttpRequest.BodyPublishers.noBody())
        val response = http.send(builder.build(), HttpResponse.BodyHandlers.ofString())
        require(response.statusCode() in 200..299) { "Goodbase request failed with ${response.statusCode()}" }
        return response.body()
    }
}

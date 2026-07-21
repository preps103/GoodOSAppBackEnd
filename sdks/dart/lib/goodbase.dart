import 'dart:convert';
import 'dart:io';

class GoodbaseClient {
  GoodbaseClient({this.baseUrl = 'https://base.goodos.app', this.accessToken});
  final String baseUrl;
  String? accessToken;

  Future<Map<String, dynamic>> request(String path, {String method = 'GET', Object? body}) async {
    final client = HttpClient();
    final request = await client.openUrl(method, Uri.parse('$baseUrl$path'));
    request.headers.set(HttpHeaders.acceptHeader, 'application/json');
    request.headers.set('X-Request-ID', DateTime.now().microsecondsSinceEpoch.toString());
    if (accessToken != null) request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $accessToken');
    if (body != null) { request.headers.contentType = ContentType.json; request.write(jsonEncode(body)); }
    final response = await request.close();
    final payload = jsonDecode(await utf8.decodeStream(response)) as Map<String, dynamic>;
    if (response.statusCode >= 400) throw HttpException(payload['message']?.toString() ?? 'Goodbase request failed', uri: Uri.parse('$baseUrl$path'));
    return payload;
  }
}

import 'dart:convert';
import 'dart:io';

class GoodbaseClient {
  GoodbaseClient({this.baseUrl = 'https://base.goodos.app', this.accessToken, this.attestationToken});
  final String baseUrl;
  String? accessToken;
  String? attestationToken;

  Future<Map<String, dynamic>> request(String path, {String method = 'GET', Object? body}) async {
    final client = HttpClient();
    final request = await client.openUrl(method, Uri.parse('$baseUrl$path'));
    request.headers.set(HttpHeaders.acceptHeader, 'application/json');
    request.headers.set('X-Request-ID', DateTime.now().microsecondsSinceEpoch.toString());
    if (accessToken != null) request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $accessToken');
    if (attestationToken != null) request.headers.set('X-Goodbase-Attestation', attestationToken!);
    if (body != null) { request.headers.contentType = ContentType.json; request.write(jsonEncode(body)); }
    final response = await request.close();
    final payload = jsonDecode(await utf8.decodeStream(response)) as Map<String, dynamic>;
    if (response.statusCode >= 400) throw HttpException(payload['message']?.toString() ?? 'Goodbase request failed', uri: Uri.parse('$baseUrl$path'));
    return payload;
  }

  Future<Map<String, dynamic>> exchangeAttestation(String appId, String platform, Map<String, dynamic> assertion) async {
    final challenge = await request('/api/goodbase/v1/growth/attestation/challenge', method: 'POST', body: {'appId': appId, 'platform': platform});
    final result = await request('/api/goodbase/v1/growth/attestation/exchange', method: 'POST', body: {'challengeId': challenge['challengeId'], 'nonce': challenge['nonce'], 'assertion': assertion});
    attestationToken = result['attestationToken']?.toString();
    return result;
  }

  Future<Map<String, dynamic>> registerMessagingDevice({required String appId, required String platform, required String deviceToken, String? locale, String? timezone}) =>
      request('/api/goodbase/v1/growth/messaging/devices', method: 'POST', body: {'appId': appId, 'platform': platform, 'deviceToken': deviceToken, 'locale': locale, 'timezone': timezone});

  Future<Map<String, dynamic>> track(Map<String, dynamic> payload) => request('/api/goodbase/v1/product/analytics/events', method: 'POST', body: payload);
  Future<Map<String, dynamic>> captureCrash(Map<String, dynamic> payload) => request('/api/goodbase/v1/product/telemetry/crashes', method: 'POST', body: payload);
  Future<Map<String, dynamic>> recordTrace(Map<String, dynamic> payload) => request('/api/goodbase/v1/product/telemetry/traces', method: 'POST', body: payload);
  Future<Map<String, dynamic>> remoteConfig(String appId) => request('/api/goodbase/v1/product/config/$appId');
  Future<Map<String, dynamic>> experimentAssignments(String appId) => request('/api/goodbase/v1/product/experiments/$appId/assignments');
}

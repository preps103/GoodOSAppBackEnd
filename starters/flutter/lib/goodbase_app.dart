import '../../../sdks/dart/lib/goodbase.dart';

final goodbase = GoodbaseClient();

Future<void> secureDevice(String appId, Map<String, dynamic> assertion, String token) async {
  await goodbase.exchangeAttestation(appId, 'flutter', assertion);
  await goodbase.registerMessagingDevice(appId: appId, platform: 'flutter', deviceToken: token);
}


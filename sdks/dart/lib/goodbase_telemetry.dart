import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui';
import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'goodbase.dart';

enum GoodbaseConsent { granted, essential, denied }

class GoodbaseTelemetryConfig {
  const GoodbaseTelemetryConfig({required this.appId, required this.release, required this.buildNumber, this.distributionTrack, required this.storageDirectory});
  final String appId;
  final String release;
  final String buildNumber;
  final String? distributionTrack;
  final Directory storageDirectory;
}

class GoodbaseTelemetry with WidgetsBindingObserver {
  GoodbaseTelemetry(this.client, this.config, {this.consent = GoodbaseConsent.denied})
      : sessionId = '${DateTime.now().microsecondsSinceEpoch}-${Platform.localHostname}',
        _buffer = File('${config.storageDirectory.path}/goodbase-${config.appId.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_')}.jsonl');

  final GoodbaseClient client;
  final GoodbaseTelemetryConfig config;
  final String sessionId;
  GoodbaseConsent consent;
  final File _buffer;
  final List<Map<String, Object?>> _breadcrumbs = [];
  final Map<String, String> _customKeys = {};
  FlutterExceptionHandler? _previousFlutterHandler;
  ErrorCallback? _previousPlatformHandler;
  Timer? _flushTimer;
  bool _started = false;

  Future<void> start() async {
    if (_started || consent == GoodbaseConsent.denied) return;
    _started = true;
    WidgetsBinding.instance.addObserver(this);
    _previousFlutterHandler = FlutterError.onError;
    FlutterError.onError = (details) { capture(details.exception, details.stack, fatal: true, type: 'FlutterError'); _previousFlutterHandler?.call(details); };
    _previousPlatformHandler = PlatformDispatcher.instance.onError;
    PlatformDispatcher.instance.onError = (error, stack) { capture(error, stack, fatal: true, type: 'PlatformError'); return _previousPlatformHandler?.call(error, stack) ?? false; };
    await _session('start');
    await flush();
    _flushTimer = Timer.periodic(const Duration(seconds: 30), (_) => flush());
  }

  Future<void> stop() async {
    if (!_started) return;
    await _session('end', endedReason: 'normal');
    WidgetsBinding.instance.removeObserver(this);
    FlutterError.onError = _previousFlutterHandler;
    PlatformDispatcher.instance.onError = _previousPlatformHandler;
    _flushTimer?.cancel();
    _started = false;
  }

  Future<void> setConsent(GoodbaseConsent value) async {
    consent = value;
    if (value == GoodbaseConsent.denied) { if (await _buffer.exists()) await _buffer.delete(); await stop(); } else { await start(); }
  }

  void breadcrumb(String message, [Map<String, Object?> data = const {}]) {
    _breadcrumbs.add({'message': message.length > 500 ? message.substring(0, 500) : message, 'data': data, 'at': DateTime.now().toUtc().toIso8601String()});
    if (_breadcrumbs.length > 50) _breadcrumbs.removeAt(0);
  }

  void setCustomKey(String key, Object? value) { if (_customKeys.containsKey(key) || _customKeys.length < 64) _customKeys[key] = value.toString(); }

  Future<void> capture(Object error, StackTrace? stack, {bool fatal = false, String? type}) => _send('crash', {
    'appId': config.appId, 'platform': 'flutter', 'occurredAt': DateTime.now().toUtc().toIso8601String(),
    'title': error.toString(), 'stackTrace': stack?.toString(), 'sessionId': sessionId, 'release': config.release,
    'buildNumber': config.buildNumber, 'fatal': fatal, 'exceptionType': type ?? error.runtimeType.toString(),
    'breadcrumbs': _breadcrumbs, 'customKeys': _customKeys,
    'device': {'os': Platform.operatingSystem, 'osVersion': Platform.operatingSystemVersion, 'locale': PlatformDispatcher.instance.locale.toLanguageTag()}
  });

  Future<T> trace<T>(String name, Future<T> Function() operation, {String type = 'custom'}) async {
    final watch = Stopwatch()..start();
    try { return await operation(); } catch (error, stack) { await capture(error, stack, type: 'nonfatal'); rethrow; }
    finally { await _send('trace', {'appId': config.appId, 'type': type, 'name': name, 'durationMs': watch.elapsedMicroseconds / 1000, 'occurredAt': DateTime.now().toUtc().toIso8601String()}); }
  }

  Future<void> flush() async {
    if (consent == GoodbaseConsent.denied || !await _buffer.exists()) return;
    final events = (await _buffer.readAsLines()).map((line) { try { return jsonDecode(line) as Map<String, dynamic>; } catch (_) { return null; } }).whereType<Map<String, dynamic>>();
    final remaining = <Map<String, dynamic>>[];
    for (final event in events) { try { await _upload(event); } catch (_) { remaining.add(event); } }
    await _replace(remaining.take(100).toList());
  }

  Future<void> _session(String action, {String? endedReason}) => _send('session', {'appId': config.appId, 'sessionId': sessionId, 'action': action, 'consentState': consent.name, 'occurredAt': DateTime.now().toUtc().toIso8601String(), 'release': config.release, 'buildNumber': config.buildNumber, 'distributionTrack': config.distributionTrack, 'endedReason': endedReason});
  Future<void> _send(String kind, Map<String, Object?> payload) async { if (consent == GoodbaseConsent.denied) return; final event={'kind':kind,'payload':payload}; try { await _upload(event); } catch (_) { await _append(event); } }
  Future<void> _upload(Map<String, dynamic> event) { final payload=Map<String,dynamic>.from(event['payload'] as Map); return event['kind']=='crash' ? client.captureCrash(payload) : event['kind']=='session' ? client.recordSession(payload) : client.recordTrace(payload); }
  Future<void> _append(Map<String, Object?> event) async { await config.storageDirectory.create(recursive:true); final rows=await _buffer.exists()?await _buffer.readAsLines():<String>[];rows.add(jsonEncode(event));await _buffer.writeAsString('${rows.reversed.take(100).toList().reversed.join('\n')}\n',flush:true); }
  Future<void> _replace(List<Map<String,dynamic>> events) async { await config.storageDirectory.create(recursive:true); final temp=File('${_buffer.path}.tmp');await temp.writeAsString(events.map(jsonEncode).join('\n'),flush:true);await temp.rename(_buffer.path); }

  @override void didChangeAppLifecycleState(AppLifecycleState state) { if (state==AppLifecycleState.resumed) { _session('foreground'); flush(); } else if (state==AppLifecycleState.paused || state==AppLifecycleState.detached) { _session('background',endedReason:state.name); } }
}

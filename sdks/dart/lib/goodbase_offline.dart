import 'dart:convert';
import 'dart:io';

abstract interface class GoodbaseOfflineCipher {
  List<int> seal(List<int> plaintext);
  List<int> open(List<int> ciphertext);
}

class GoodbaseOfflineStore {
  GoodbaseOfflineStore._(this._file, this._userNamespace, this._cipher, this._state);
  final File _file;
  final String _userNamespace;
  final GoodbaseOfflineCipher _cipher;
  Map<String, dynamic> _state;

  static Future<GoodbaseOfflineStore> open({required Directory applicationSupportDirectory, required String userNamespace, required GoodbaseOfflineCipher cipher, int schemaVersion = 1}) async {
    final safe = base64Url.encode(utf8.encode(userNamespace)).replaceAll('=', '');
    final directory = Directory('${applicationSupportDirectory.path}/goodbase-offline'); await directory.create(recursive: true);
    final file = File('${directory.path}/$safe.store');
    var state = <String, dynamic>{'schemaVersion': schemaVersion, 'userNamespace': userNamespace, 'cursor': 0, 'mutations': <dynamic>[]};
    if (await file.exists()) { state = jsonDecode(utf8.decode(cipher.open(await file.readAsBytes()))) as Map<String, dynamic>; if (state['userNamespace'] != userNamespace || (state['schemaVersion'] as int? ?? 0) > schemaVersion) throw const FormatException('Goodbase offline store namespace or schema mismatch.'); state['schemaVersion'] = schemaVersion; }
    return GoodbaseOfflineStore._(file, userNamespace, cipher, state);
  }
  Future<Map<String, dynamic>> queue({required String collection, required String recordKey, String operation = 'upsert', int? expectedVersion, Object? value, String? idempotencyKey}) async {
    final mutations = (_state['mutations'] as List).cast<Map<String, dynamic>>(); final key = idempotencyKey ?? '${DateTime.now().microsecondsSinceEpoch}-${ProcessInfo.currentRss}';
    final duplicate = mutations.where((item) => item['idempotencyKey'] == key); if (duplicate.isNotEmpty) return duplicate.first;
    final mutation = <String, dynamic>{'idempotencyKey': key, 'collection': collection, 'recordKey': recordKey, 'operation': operation == 'delete' ? 'delete' : 'upsert', 'expectedVersion': expectedVersion, 'value': value, 'createdAt': DateTime.now().toUtc().toIso8601String()}; mutations.add(mutation); _state['mutations'] = mutations; await _persist(); return mutation;
  }
  List<Map<String, dynamic>> pending({int limit = 100}) => (_state['mutations'] as List).cast<Map<String, dynamic>>().take(limit.clamp(1, 1000)).toList(growable: false);
  int get cursor => _state['cursor'] as int? ?? 0;
  Future<void> acknowledge(Set<String> keys, int nextCursor) async { final mutations = (_state['mutations'] as List).cast<Map<String, dynamic>>(); mutations.removeWhere((item) => keys.contains(item['idempotencyKey'])); _state['mutations'] = mutations; _state['cursor'] = nextCursor > cursor ? nextCursor : cursor; await _persist(); }
  Future<void> clearForLogout() async { _state = {'schemaVersion': _state['schemaVersion'], 'userNamespace': _userNamespace, 'cursor': 0, 'mutations': <dynamic>[]}; if (await _file.exists()) await _file.delete(); }
  Future<void> _persist() async { final temporary = File('${_file.path}.tmp'); await temporary.writeAsBytes(_cipher.seal(utf8.encode(jsonEncode(_state))), flush: true); await temporary.rename(_file.path); }
}

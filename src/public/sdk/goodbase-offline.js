(function goodbaseOfflineModule(global) {
  "use strict";

  function requestId() {
    return global.crypto && global.crypto.randomUUID
      ? global.crypto.randomUUID()
      : "sync_" + Date.now() + "_" + Math.random().toString(16).slice(2);
  }

  function transactionDone(transaction) {
    return new Promise(function (resolve, reject) {
      transaction.oncomplete = function () { resolve(); };
      transaction.onerror = function () { reject(transaction.error); };
      transaction.onabort = function () { reject(transaction.error || new Error("Offline transaction aborted.")); };
    });
  }

  function requestDone(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  function GoodbaseOfflineStore(options) {
    options = options || {};
    if (!options.client) throw new Error("Goodbase client is required.");
    if (!options.userId) throw new Error("A user ID is required for cache isolation.");
    this.client = options.client;
    this.userId = String(options.userId);
    this.databaseName = "goodbase-offline-" + this.userId.replace(/[^a-zA-Z0-9_-]/g, "_");
    this.database = null;
    this.listeners = new Set();
  }

  GoodbaseOfflineStore.prototype.open = async function () {
    if (this.database) return this;
    var openRequest = global.indexedDB.open(this.databaseName, 1);
    openRequest.onupgradeneeded = function () {
      var database = openRequest.result;
      if (!database.objectStoreNames.contains("records")) database.createObjectStore("records", { keyPath: "key" });
      if (!database.objectStoreNames.contains("mutations")) database.createObjectStore("mutations", { keyPath: "idempotencyKey" });
      if (!database.objectStoreNames.contains("metadata")) database.createObjectStore("metadata", { keyPath: "key" });
    };
    this.database = await requestDone(openRequest);
    return this;
  };

  GoodbaseOfflineStore.prototype.onSync = function (listener) {
    this.listeners.add(listener);
    return function () { this.listeners.delete(listener); }.bind(this);
  };

  GoodbaseOfflineStore.prototype.emit = function (event) {
    this.listeners.forEach(function (listener) { listener(event); });
  };

  GoodbaseOfflineStore.prototype.get = async function (collectionId, recordKey) {
    await this.open();
    var transaction = this.database.transaction("records", "readonly");
    var value = await requestDone(transaction.objectStore("records").get(collectionId + ":" + recordKey));
    return value && !value.deleted ? value : null;
  };

  GoodbaseOfflineStore.prototype.mutate = async function (collectionId, recordKey, operation, value, options) {
    await this.open();
    options = options || {};
    var idempotencyKey = options.idempotencyKey || requestId();
    var key = collectionId + ":" + recordKey;
    var transaction = this.database.transaction(["records", "mutations"], "readwrite");
    var records = transaction.objectStore("records");
    var current = await requestDone(records.get(key));
    var mutation = {
      idempotencyKey: idempotencyKey,
      collectionId: collectionId,
      recordKey: recordKey,
      operation: operation === "delete" ? "delete" : "upsert",
      value: operation === "delete" ? null : value,
      baseValue: current ? current.value : null,
      expectedVersion: current ? current.version : 0,
      createdAt: new Date().toISOString()
    };
    transaction.objectStore("mutations").put(mutation);
    records.put({ key:key,collectionId:collectionId,recordKey:recordKey,value:value||{},version:current?current.version:0,deleted:operation==="delete",pending:true });
    await transactionDone(transaction);
    this.emit({ type:"mutation-queued",mutation:mutation });
    return mutation;
  };

  GoodbaseOfflineStore.prototype.sync = async function (collectionId, deviceId) {
    await this.open();
    if (!global.navigator.onLine) return { online:false,pending:true };
    this.emit({ type:"sync-started",collectionId:collectionId });
    var read = this.database.transaction(["mutations","metadata"], "readonly");
    var pending = await requestDone(read.objectStore("mutations").getAll());
    pending = pending.filter(function (item) { return item.collectionId === collectionId; });
    var cursorEntry = await requestDone(read.objectStore("metadata").get("cursor:" + collectionId));
    var mutationResult = pending.length
      ? await this.client.syncMutations(collectionId, { deviceId:deviceId,mutations:pending })
      : { results:[] };
    var changes = await this.client.syncChanges(collectionId, { cursor:cursorEntry?cursorEntry.value:0,limit:1000 });
    var write = this.database.transaction(["records","mutations","metadata"], "readwrite");
    var recordStore = write.objectStore("records");
    var mutationStore = write.objectStore("mutations");
    (mutationResult.results || []).forEach(function (result) {
      if (result.status === "applied") mutationStore.delete(result.idempotencyKey || result.id);
    });
    (changes.changes || []).forEach(function (change) {
      recordStore.put({ key:collectionId+":"+change.record_key,collectionId:collectionId,recordKey:change.record_key,value:change.value_json||{},version:Number(change.version),deleted:change.operation==="delete",pending:false });
    });
    write.objectStore("metadata").put({ key:"cursor:"+collectionId,value:changes.cursor||0 });
    await transactionDone(write);
    var result = { online:true,uploaded:pending.length,downloaded:(changes.changes||[]).length,cursor:changes.cursor||0 };
    this.emit({ type:"sync-completed",...result });
    return result;
  };

  GoodbaseOfflineStore.prototype.clear = async function () {
    if (this.database) { this.database.close(); this.database = null; }
    await requestDone(global.indexedDB.deleteDatabase(this.databaseName));
  };

  global.GoodbaseOfflineStore = GoodbaseOfflineStore;
})(typeof window !== "undefined" ? window : globalThis);

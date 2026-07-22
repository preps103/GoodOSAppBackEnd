import Foundation
#if canImport(UIKit)
import UIKit
#endif
#if canImport(MetricKit)
import MetricKit
#endif

public final class GoodbaseTelemetry: NSObject, @unchecked Sendable {
    public enum Consent: String, Codable, Sendable { case granted, essential, denied }
    public struct Configuration: Sendable {
        public let appID: String; public let release: String; public let buildNumber: String
        public let anonymousID: String?; public let installationID: String?; public let distributionTrack: String?
        public init(appID: String, release: String, buildNumber: String, anonymousID: String? = nil, installationID: String? = nil, distributionTrack: String? = nil) {
            self.appID=appID;self.release=release;self.buildNumber=buildNumber;self.anonymousID=anonymousID;self.installationID=installationID;self.distributionTrack=distributionTrack
        }
    }
    private struct BufferedEvent: Codable { let kind: String; let payload: Data; let queuedAt: Date }
    private let client: GoodbaseClient,configuration: Configuration,sessionID=UUID().uuidString,bufferURL: URL
    private let lock=NSLock();private var consent: Consent;private var breadcrumbs=[[String:String]]();private var customKeys=[String:String]();private var observers=[NSObjectProtocol]();private var started=false
#if canImport(MetricKit)
    private var metricSubscriber: GoodbaseMetricSubscriber?
#endif
    public init(client: GoodbaseClient, configuration: Configuration, consent: Consent = .denied, applicationSupportDirectory: URL? = nil) {
        self.client=client;self.configuration=configuration;self.consent=consent
        let root=applicationSupportDirectory ?? FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask).first!
        let directory=root.appendingPathComponent("GoodbaseTelemetry",isDirectory:true);try? FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,attributes:nil)
        self.bufferURL=directory.appendingPathComponent("\(configuration.appID).events");super.init()
    }
    public func start() async { guard currentConsent() != .denied else{return};guard updateStarted(true) else{await flush();return};await session(action:"start");installLifecycle();installMetricKit();await flush() }
    public func stop() async { guard updateStarted(false) else{return};await session(action:"end",endedReason:"normal");for observer in observers{NotificationCenter.default.removeObserver(observer)};observers.removeAll()
#if canImport(MetricKit)
        if let metricSubscriber{MXMetricManager.shared.remove(metricSubscriber)};metricSubscriber=nil
#endif
    }
    public func setConsent(_ value: Consent) async {setConsentState(value);if value == .denied{try? FileManager.default.removeItem(at:bufferURL);await stop()}else{await start()} }
    public func breadcrumb(_ message: String, data: [String:String] = [:]) {lock.lock();breadcrumbs.append(["message":String(message.prefix(500)),"data":String(describing:data),"at":ISO8601DateFormatter().string(from:Date())]);if breadcrumbs.count>50{breadcrumbs.removeFirst()};lock.unlock()}
    public func setCustomKey(_ key: String, value: CustomStringConvertible) {lock.lock();if customKeys[key] != nil || customKeys.count<64{customKeys[String(key.prefix(100))]=String(String(describing:value).prefix(1000))};lock.unlock()}
    public func capture(_ error: Error, fatal: Bool = false, exceptionType: String? = nil) async {await crash(title:error.localizedDescription,stack:String(reflecting:error),fatal:fatal,exceptionType:exceptionType ?? String(describing:type(of:error)))}
    public func captureDiagnostic(title: String, stack: String, fatal: Bool) async {await crash(title:title,stack:stack,fatal:fatal,exceptionType:"MetricKit")}
    public func trace<T>(_ name: String, type: String = "custom", operation: () async throws -> T) async rethrows -> T {let started=Date();do{let value=try await operation();await sendTrace(name:name,type:type,duration:Date().timeIntervalSince(started)*1000,success:true);return value}catch{await capture(error,fatal:false,exceptionType:"nonfatal");await sendTrace(name:name,type:type,duration:Date().timeIntervalSince(started)*1000,success:false);throw error}}
    public func flush() async {guard currentConsent() != .denied,let data=try? Data(contentsOf:bufferURL),let events=try? JSONDecoder().decode([BufferedEvent].self,from:data)else{return};var remaining=[BufferedEvent]();for event in events{do{if event.kind=="session"{let body=try JSONDecoder().decode(GoodbaseClient.SessionRequest.self,from:event.payload);let _:GoodbaseClient.ProductResponse=try await client.request("/api/goodbase/v1/product/telemetry/sessions",method:"POST",body:body)}else if event.kind=="crash"{let body=try JSONDecoder().decode(GoodbaseClient.CrashRequest.self,from:event.payload);let _:GoodbaseClient.ProductResponse=try await client.request("/api/goodbase/v1/product/telemetry/crashes",method:"POST",body:body)}else{let body=try JSONDecoder().decode(GoodbaseClient.TraceRequest.self,from:event.payload);let _:GoodbaseClient.ProductResponse=try await client.request("/api/goodbase/v1/product/telemetry/traces",method:"POST",body:body)}}catch{remaining.append(event)}};persist(remaining)}
    private func currentConsent()->Consent{lock.lock();defer{lock.unlock()};return consent}
    private func setConsentState(_ value:Consent){lock.lock();consent=value;lock.unlock()}
    private func updateStarted(_ value:Bool)->Bool{lock.lock();defer{lock.unlock()};if started==value{return false};started=value;return true}
    private func telemetryContext()->([[String:String]],[String:String]){lock.lock();defer{lock.unlock()};return(breadcrumbs,customKeys)}
    private func baseTime()->String{ISO8601DateFormatter().string(from:Date())}
    private func session(action:String,endedReason:String?=nil)async{guard currentConsent() != .denied else{return};let body=GoodbaseClient.SessionRequest(appId:configuration.appID,sessionId:sessionID,action:action,consentState:currentConsent().rawValue,occurredAt:baseTime(),anonymousId:configuration.anonymousID,installationId:configuration.installationID,release:configuration.release,buildNumber:configuration.buildNumber,distributionTrack:configuration.distributionTrack,endedReason:endedReason,properties:["locale":Locale.current.identifier]);do{let _:GoodbaseClient.ProductResponse=try await client.request("/api/goodbase/v1/product/telemetry/sessions",method:"POST",body:body)}catch{buffer("session",body)}}
    private func crash(title:String,stack:String,fatal:Bool,exceptionType:String)async{guard currentConsent() != .denied else{return};let(crumbs,keys)=telemetryContext();let body=GoodbaseClient.CrashRequest(appId:configuration.appID,platform:"ios",occurredAt:baseTime(),title:String(title.prefix(300)),stackTrace:String(stack.prefix(32000)),sessionId:sessionID,release:configuration.release,buildNumber:configuration.buildNumber,fatal:fatal,exceptionType:exceptionType,breadcrumbs:crumbs,customKeys:keys,device:["os":ProcessInfo.processInfo.operatingSystemVersionString,"locale":Locale.current.identifier]);do{let _:GoodbaseClient.ProductResponse=try await client.captureCrash(body)}catch{buffer("crash",body)}}
    private func sendTrace(name:String,type:String,duration:Double,success:Bool)async{guard currentConsent() != .denied else{return};let allowed=["startup","screen","network","custom","anr"],body=GoodbaseClient.TraceRequest(appId:configuration.appID,type:allowed.contains(type) ? type:"custom",name:String(name.prefix(200)),durationMs:duration,occurredAt:baseTime());do{let _:GoodbaseClient.ProductResponse=try await client.recordTrace(body)}catch{buffer("trace",body)}}
    private func buffer<T:Encodable>(_ kind:String,_ value:T){guard let payload=try? JSONEncoder().encode(value)else{return};var events=(try? Data(contentsOf:bufferURL)).flatMap{try? JSONDecoder().decode([BufferedEvent].self,from:$0)} ?? [];events.append(BufferedEvent(kind:kind,payload:payload,queuedAt:Date()));persist(Array(events.suffix(100)))}
    private func persist(_ events:[BufferedEvent]){guard let data=try? JSONEncoder().encode(events)else{return};try? data.write(to:bufferURL,options:[.atomic,.completeFileProtectionUntilFirstUserAuthentication])}
    private func installLifecycle(){
#if canImport(UIKit)
        let center=NotificationCenter.default
        observers.append(center.addObserver(forName:UIApplication.didBecomeActiveNotification,object:nil,queue:nil){[weak self]_ in Task{await self?.session(action:"heartbeat")}})
        observers.append(center.addObserver(forName:UIApplication.didEnterBackgroundNotification,object:nil,queue:nil){[weak self]_ in Task{await self?.session(action:"end",endedReason:"background")}})
        observers.append(center.addObserver(forName:UIApplication.willTerminateNotification,object:nil,queue:nil){[weak self]_ in Task{await self?.session(action:"end",endedReason:"normal")}})
#endif
    }
    private func installMetricKit(){
#if canImport(MetricKit)
        let subscriber=GoodbaseMetricSubscriber(telemetry:self);metricSubscriber=subscriber;MXMetricManager.shared.add(subscriber)
#endif
    }
}

#if canImport(MetricKit)
private final class GoodbaseMetricSubscriber:NSObject,MXMetricManagerSubscriber{
    weak var telemetry:GoodbaseTelemetry?;init(telemetry:GoodbaseTelemetry){self.telemetry=telemetry}
    func didReceive(_ payloads:[MXDiagnosticPayload]){for payload in payloads{let data=payload.jsonRepresentation(),text=String(data:data,encoding:.utf8) ?? "MetricKit diagnostic";Task{await telemetry?.captureDiagnostic(title:"Apple diagnostic",stack:text,fatal:payload.crashDiagnostics?.isEmpty==false)}}}
}
#endif

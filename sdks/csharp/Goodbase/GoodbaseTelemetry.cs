using System.Diagnostics;
using System.Text.Json;

namespace Goodbase;

public enum GoodbaseConsent { Granted, Essential, Denied }

public sealed record GoodbaseTelemetryOptions(string AppId, string Release, string BuildNumber, string StorageDirectory, string? DistributionTrack = null);

public sealed class GoodbaseTelemetry : IDisposable
{
    private readonly GoodbaseClient _client;
    private readonly GoodbaseTelemetryOptions _options;
    private readonly string _sessionId = Guid.NewGuid().ToString();
    private readonly string _spool;
    private readonly object _sync = new();
    private readonly List<Dictionary<string, object?>> _breadcrumbs = [];
    private readonly Dictionary<string, string> _customKeys = [];
    private bool _started;
    public GoodbaseConsent Consent { get; private set; }

    public GoodbaseTelemetry(GoodbaseClient client, GoodbaseTelemetryOptions options, GoodbaseConsent consent = GoodbaseConsent.Denied)
    {
        _client=client; _options=options; Consent=consent;
        Directory.CreateDirectory(options.StorageDirectory);
        _spool=Path.Combine(options.StorageDirectory, $"goodbase-{Sanitize(options.AppId)}.jsonl");
    }

    public void Start()
    {
        if (_started || Consent == GoodbaseConsent.Denied) return;
        _started=true; AppDomain.CurrentDomain.UnhandledException += OnUnhandledException;
        TaskScheduler.UnobservedTaskException += OnUnobservedTaskException;
        Send("session", SessionPayload("start")); _ = FlushAsync();
    }

    public void SetConsent(GoodbaseConsent value)
    {
        Consent=value;
        if (value == GoodbaseConsent.Denied) { if(File.Exists(_spool))File.Delete(_spool); Dispose(); } else Start();
    }

    public void Breadcrumb(string message, IReadOnlyDictionary<string, object?>? data = null)
    {
        lock(_sync){_breadcrumbs.Add(new(){["message"]=message[..Math.Min(message.Length,500)],["data"]=data,["at"]=DateTimeOffset.UtcNow});if(_breadcrumbs.Count>50)_breadcrumbs.RemoveAt(0);}
    }

    public void SetCustomKey(string key, object? value) { lock(_sync){if(_customKeys.ContainsKey(key)||_customKeys.Count<64){var text=value?.ToString()??"";_customKeys[key[..Math.Min(key.Length,100)]]=text[..Math.Min(text.Length,1000)];}} }
    public void CaptureException(Exception error, bool fatal=false, string? type=null) => Send("crash", CrashPayload(error,fatal,type));

    public async Task<T> TraceAsync<T>(string name, Func<Task<T>> operation, string type="custom")
    {
        var watch=Stopwatch.StartNew();try{return await operation();}catch(Exception error){CaptureException(error);throw;}finally{Send("trace",new{appId=_options.AppId,type,name,durationMs=watch.Elapsed.TotalMilliseconds,occurredAt=DateTimeOffset.UtcNow});}
    }

    public async Task FlushAsync(CancellationToken cancellationToken=default)
    {
        if(Consent==GoodbaseConsent.Denied||!File.Exists(_spool))return;
        List<JsonElement> remaining=[];
        string[] lines;lock(_sync)lines=File.ReadAllLines(_spool);
        foreach(var line in lines){try{using var document=JsonDocument.Parse(line);await UploadAsync(document.RootElement,cancellationToken);}catch{try{using var document=JsonDocument.Parse(line);remaining.Add(document.RootElement.Clone());}catch{}}}
        Replace(remaining.Select(value => JsonSerializer.Serialize(value)).TakeLast(100));
    }

    private object SessionPayload(string action,string? endedReason=null)=>new{appId=_options.AppId,sessionId=_sessionId,action,consentState=Consent.ToString().ToLowerInvariant(),occurredAt=DateTimeOffset.UtcNow,release=_options.Release,buildNumber=_options.BuildNumber,distributionTrack=_options.DistributionTrack,endedReason};
    private object CrashPayload(Exception error,bool fatal,string? type){lock(_sync)return new{appId=_options.AppId,platform="dotnet",occurredAt=DateTimeOffset.UtcNow,title=error.Message,stackTrace=error.ToString(),sessionId=_sessionId,release=_options.Release,buildNumber=_options.BuildNumber,fatal,exceptionType=type??error.GetType().FullName,breadcrumbs=_breadcrumbs.ToArray(),customKeys=new Dictionary<string,string>(_customKeys),device=new{os=Environment.OSVersion.ToString(),runtime=Environment.Version.ToString()}};}
    private void Send(string kind,object payload){if(Consent==GoodbaseConsent.Denied)return;var json=JsonSerializer.Serialize(new{kind,payload});_ = Task.Run(async()=>{try{using var document=JsonDocument.Parse(json);await UploadAsync(document.RootElement);}catch{Append(json);}});}
    private async Task UploadAsync(JsonElement eventValue,CancellationToken cancellationToken=default){var kind=eventValue.GetProperty("kind").GetString();var body=eventValue.GetProperty("payload").GetRawText();if(kind=="session")await _client.RecordSessionAsync(body,cancellationToken);else if(kind=="crash")await _client.CaptureCrashAsync(body,cancellationToken);else await _client.RecordTraceAsync(body,cancellationToken);}
    private void Append(string line){lock(_sync){var lines=File.Exists(_spool)?File.ReadAllLines(_spool).ToList():[];lines.Add(line);Replace(lines.TakeLast(100));}}
    private void Replace(IEnumerable<string> lines){var temporary=_spool+".tmp";File.WriteAllLines(temporary,lines);File.Move(temporary,_spool,true);}
    private void OnUnhandledException(object sender,UnhandledExceptionEventArgs args){if(args.ExceptionObject is Exception error){var json=JsonSerializer.Serialize(new{kind="crash",payload=CrashPayload(error,true,"UnhandledException")});Append(json);}}
    private void OnUnobservedTaskException(object? sender,UnobservedTaskExceptionEventArgs args){CaptureException(args.Exception,false,"UnobservedTaskException");}
    private static string Sanitize(string value)=>string.Concat(value.Select(ch=>char.IsLetterOrDigit(ch)||"._-".Contains(ch)?ch:'_'));
    public void Dispose(){if(!_started)return;Send("session",SessionPayload("end","normal"));AppDomain.CurrentDomain.UnhandledException-=OnUnhandledException;TaskScheduler.UnobservedTaskException-=OnUnobservedTaskException;_started=false;}
}

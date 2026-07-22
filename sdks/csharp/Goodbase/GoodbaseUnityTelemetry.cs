#if UNITY_2021_3_OR_NEWER
using System;
using UnityEngine;

namespace Goodbase;

public sealed class GoodbaseUnityTelemetry : MonoBehaviour
{
    public GoodbaseTelemetry? Telemetry { get; private set; }
    public void Configure(GoodbaseClient client,string appId,string release,string buildNumber,GoodbaseConsent consent)
    {
        Telemetry=new GoodbaseTelemetry(client,new(appId,release,buildNumber,Application.persistentDataPath),consent);
        Application.logMessageReceivedThreaded+=OnLog;Telemetry.Start();DontDestroyOnLoad(gameObject);
    }
    private void OnLog(string condition,string stackTrace,LogType type){if(type is LogType.Exception or LogType.Error or LogType.Assert)Telemetry?.CaptureException(new Exception(condition+"\n"+stackTrace),type==LogType.Exception,"Unity"+type);}
    private void OnApplicationPause(bool paused){Telemetry?.Breadcrumb(paused?"application.background":"application.foreground");if(!paused)_=Telemetry?.FlushAsync();}
    private void OnApplicationQuit(){Telemetry?.Dispose();}
    private void OnDestroy(){Application.logMessageReceivedThreaded-=OnLog;}
}
#endif

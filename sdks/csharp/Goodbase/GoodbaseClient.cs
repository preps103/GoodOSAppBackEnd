using System.Net.Http.Headers;
using System.Text;

namespace Goodbase;

public sealed class GoodbaseClient
{
    private readonly HttpClient _http;
    public string? AccessToken { get; set; }
    public string? AttestationToken { get; set; }

    public GoodbaseClient(HttpClient? http = null, string baseUrl = "https://base.goodos.app")
    {
        _http = http ?? new HttpClient();
        _http.BaseAddress = new Uri(baseUrl.TrimEnd('/') + "/");
    }

    public async Task<string> RequestAsync(string path, HttpMethod? method = null, string? json = null, CancellationToken cancellationToken = default)
    {
        using var request = new HttpRequestMessage(method ?? HttpMethod.Get, path.TrimStart('/'));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Headers.Add("X-Request-ID", Guid.NewGuid().ToString());
        if (AccessToken is not null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", AccessToken);
        if (AttestationToken is not null) request.Headers.Add("X-Goodbase-Attestation", AttestationToken);
        if (json is not null) request.Content = new StringContent(json, Encoding.UTF8, "application/json");
        using var response = await _http.SendAsync(request, cancellationToken);
        var payload = await response.Content.ReadAsStringAsync(cancellationToken);
        response.EnsureSuccessStatusCode();
        return payload;
    }

    public Task<string> RecordSessionAsync(string json, CancellationToken cancellationToken = default) => RequestAsync("/api/goodbase/v1/product/telemetry/sessions", HttpMethod.Post, json, cancellationToken);
    public Task<string> CaptureCrashAsync(string json, CancellationToken cancellationToken = default) => RequestAsync("/api/goodbase/v1/product/telemetry/crashes", HttpMethod.Post, json, cancellationToken);
    public Task<string> RecordTraceAsync(string json, CancellationToken cancellationToken = default) => RequestAsync("/api/goodbase/v1/product/telemetry/traces", HttpMethod.Post, json, cancellationToken);
    public Task<string> RemoteConfigAsync(string appId, CancellationToken cancellationToken = default) => RequestAsync($"/api/goodbase/v1/product/config/{Uri.EscapeDataString(appId)}", cancellationToken: cancellationToken);
    public Task<string> ExperimentAssignmentsAsync(string appId, CancellationToken cancellationToken = default) => RequestAsync($"/api/goodbase/v1/product/experiments/{Uri.EscapeDataString(appId)}/assignments", cancellationToken: cancellationToken);
    public Task<string> RegisterPushTokenAsync(string json, CancellationToken cancellationToken = default) => RequestAsync("/api/goodbase/v1/growth/messaging/devices", HttpMethod.Post, json, cancellationToken);
}

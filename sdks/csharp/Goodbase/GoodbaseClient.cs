using System.Net.Http.Headers;
using System.Text;

namespace Goodbase;

public sealed class GoodbaseClient
{
    private readonly HttpClient _http;
    public string? AccessToken { get; set; }

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
        if (json is not null) request.Content = new StringContent(json, Encoding.UTF8, "application/json");
        using var response = await _http.SendAsync(request, cancellationToken);
        var payload = await response.Content.ReadAsStringAsync(cancellationToken);
        response.EnsureSuccessStatusCode();
        return payload;
    }
}

const ALLOWED_ORIGIN = "https://cookey12563.github.io";

// Use only an instance whose terms permit your use.
// Do not rotate servers to evade restrictions.
const UPSTREAM = "https://4get.ca";

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET",
      "Vary": "Origin",
      "Cache-Control": "no-store"
    }
  });
}

function plainText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(plainText).filter(Boolean).join(" ");
  }
  if (value && typeof value === "object") {
    return plainText(value.value ?? value.text ?? "");
  }
  return "";
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname !== "/search") {
      return reply({ error: "Use /search?q=your+query" }, 404);
    }

    if (request.method !== "GET") {
      return reply({ error: "Only GET requests are supported." }, 405);
    }

    const origin = request.headers.get("Origin");
    if (origin && origin !== ALLOWED_ORIGIN) {
      return reply({ error: "This browser origin is not permitted." }, 403);
    }

    const query = (url.searchParams.get("q") || "").trim();

    if (!query || query.length > 200) {
      return reply({ error: "Enter a query of 1–200 characters." }, 400);
    }

    const cacheURL = new URL(request.url);
    cacheURL.search = "";
    cacheURL.searchParams.set("q", query);
    const cacheKey = new Request(cacheURL.toString());
    const cache = caches.default;
    const cached = await cache.match(cacheKey);

    if (cached) return cached;

    const upstreamURL = new URL("/api/v1/web", UPSTREAM);
    upstreamURL.searchParams.set("s", query);

    try {
      const upstream = await fetch(upstreamURL, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(20000)
      });

      if (upstream.status === 403 || upstream.status === 429) {
        return reply({
          error:
            "4get denied this request. The instance may require an " +
            "authorized pass or may be rate-limiting requests. " +
            "This bridge cannot bypass those restrictions."
        }, 503);
      }

      if (!upstream.ok) {
        return reply({
          error: `The search provider returned HTTP ${upstream.status}.`
        }, 502);
      }

      const data = await upstream.json();

      if (data.status !== "ok") {
        return reply({
          error:
            "The search provider could not complete this search. " +
            "It may require authorization or have an upstream error."
        }, 502);
      }

      // Expected 4get web-result collection.
      // Fail visibly if the instance uses a different schema.
      if (!Array.isArray(data.web)) {
        return reply({
          error:
            "Unexpected provider response: the web-result array " +
            "was missing. The response mapping needs checking."
        }, 502);
      }

      const results = data.web.flatMap(item => {
        if (!item || typeof item !== "object") return [];

        let destination;
        try {
          destination = new URL(item.url);
        } catch {
          return [];
        }

        if (!["https:", "http:"].includes(destination.protocol)) {
          return [];
        }

        return [{
          title: plainText(item.title) || destination.hostname,
          url: destination.href,
          description: plainText(item.description).slice(0, 1200)
        }];
      }).slice(0, 50);

      const response = reply({
        results,
        provider: "4get",
        query
      });

      // Cache only successful search responses.
      const cacheResponse = new Response(response.clone().body, {
        status: 200,
        headers: response.headers
      });
      cacheResponse.headers.set("Cache-Control", "public, max-age=600");

      ctx.waitUntil(cache.put(cacheKey, cacheResponse));
      return response;
    } catch {
      return reply({
        error:
          "Could not retrieve search results. The provider may be " +
          "unavailable, require verification, or have timed out."
      }, 502);
    }
  }
};

# Owning the resolvers: what to take from yt-dlp, and what not to

The question was whether to drop yt-dlp and write our own. The answer differs
per platform, and treating it as one decision is what makes it look hard.

## Kick — ours already ✅

yt-dlp's Kick extractor does not match `/video/<uuid>` links and needs its
impersonation extra to get past Kick's bot check. `resolveKickDirect` has
existed all along, but as the **fallback after** yt-dlp failed — nineteen
"yt-dlp could not read this Kick VOD; trying Kick directly" warnings in the
log, each one a process spawned and a couple of seconds burned before reaching
the path that was always going to work.

**Done:** the order is flipped. Kick's own API first, yt-dlp kept only as the
fallback in case Kick changes shape underneath us. Channel listings already
went direct; now resolution does too.

## Twitch — ours now ✅

Twitch needs a signed `PlaybackAccessToken` from `gql.twitch.tv`, then the
token and signature appended to the `usher.ttvnw.net` m3u8 URL. That is one
documented GQL call with the public web client id — and this codebase **already
calls `gql.twitch.tv` with that client id** in `streamerProfile.ts`, for
profiles and for the bulk video dates. Adding playback access is an extension
of working code, not a new capability.

**Done.** `media/twitchDirect.ts` does the network half (GQL metadata +
`PlaybackAccessToken`, then usher); `TwitchAdapter.fromApi` does the pure
mapping, mirroring `KickAdapter.fromApi` so it is unit-testable without
importing Electron.

Developed and verified **against live Twitch on the target machine**, using a
real VOD from this roster (Skorbnut, 2h25m): title, channel, duration, publish
date and thumbnail all resolved, six renditions including the 1080p60 source,
and the top variant's playlist URL confirmed fetchable. 11 unit tests on the
mapping.

Two things fixed on the way:

- **`chunked` in the quality picker.** Twitch puts no NAME on
  `EXT-X-STREAM-INF`, only `VIDEO="chunked"`, so the parser's `NAME ?? VIDEO`
  fallback labelled the source rendition with its group id. The readable name
  is on the matching `EXT-X-MEDIA` line all along; `variantLabel()` in `hls.ts`
  joins them by group id, and 1080p60 says 1080p60.
- **`firstCodec` had been copied into two adapters.** It is HLS's attribute,
  not a platform's — now one copy in `hls.ts`.

An `auth-required` failure is no longer retried through yt-dlp: a
subscriber-only VOD will refuse it too, and burying the honest error under a
generic resolver failure is how "this VOD needs an account" became "something
went wrong".

## YouTube — keep yt-dlp ❌

This is where writing our own stops being a project and becomes a permanent
job. To get a playable YouTube URL you must:

- download YouTube's player JavaScript and **interpret it** to solve the
  signature cipher, which changes without notice;
- solve the `n` parameter or every download is throttled to a crawl;
- increasingly, produce a PO token;
- and get past the bot check that is already refusing us (see the crawler
  back-off work — 131 videos blocked in ten minutes).

yt-dlp carries roughly fifteen thousand lines for YouTube alone and a community
that ships a fix within days of each change. Writing our own means *we* become
that community, and every time YouTube ships a change the app is broken for
YouTube until someone here fixes it. The failure mode is not "slower", it is
"stops working on a Tuesday".

The honest read of the log is that yt-dlp is *already struggling* on YouTube.
Our own version would struggle more, and be ours to fix.

## Where that leaves it

| platform | resolver | yt-dlp still needed? |
|---|---|---|
| Kick | ours (done) | fallback only |
| Twitch | ours (done) | fallback only |
| YouTube | yt-dlp | yes — and it earns it |

The goal worth having is not "no yt-dlp". It is **yt-dlp only for YouTube**, so
a machine that never touches YouTube never needs it, and a yt-dlp that breaks
takes one platform down instead of three.

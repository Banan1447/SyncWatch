package main

import "testing"

func TestExtractEmbedURL(t *testing.T) {
	cases := []struct {
		name string
		html string
		want string
	}{
		{"og:video:iframe", `<meta property="og:video:iframe" content="https://player.example.com/embed/123">`, "https://player.example.com/embed/123"},
		{"og:video", `<meta property="og:video" content="https://cdn.example.com/v.mp4">`, "https://cdn.example.com/v.mp4"},
		{"og:video:url", `<meta property="og:video:url" content="https://cdn.example.com/v.mp4">`, "https://cdn.example.com/v.mp4"},
		{"og:video:secure_url", `<meta property="og:video:secure_url" content="https://cdn.example.com/v.mp4">`, "https://cdn.example.com/v.mp4"},
		{"og:video:type must not match", `<meta property="og:video:type" content="video/mp4"><meta property="og:video:width" content="1280">`, ""},
		{"vk embed", `<iframe src="https://vk.com/video_ext.php?oid=1&id=2"></iframe>`, "https://vk.com/video_ext.php?oid=1&id=2"},
		{"ok.ru embed", `<iframe src="https://ok.ru/videoembed/1234567890"></iframe>`, "https://ok.ru/videoembed/1234567890"},
		{"rutube embed", `<iframe src="https://rutube.ru/play/embed/abc123"></iframe>`, "https://rutube.ru/play/embed/abc123"},
		{"vimeo embed", `<iframe src="https://player.vimeo.com/video/76979871"></iframe>`, "https://player.vimeo.com/video/76979871"},
		{"dailymotion embed", `<iframe src="https://geo.dailymotion.com/player.html?video=x123"></iframe>`, "https://geo.dailymotion.com/player.html?video=x123"},
		{"kodik data-player regression", `<div data-player="//kodik.biz/video/123/720p"></div>`, "https://kodik.biz/video/123/720p"},
		{"kodik json player regression", `<script>var p={"player":"//kodik.biz/video/123/720p"};</script>`, "https://kodik.biz/video/123/720p"},
		{"m3u8 inline", `<script>var src="https://cdn.example.com/live.m3u8";</script>`, "https://cdn.example.com/live.m3u8"},
		{"no embed", `<html><body>just a page</body></html>`, ""},
	}
	for _, c := range cases {
		got := extractEmbedURL(c.html)
		if got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}

func TestDiscoverOEmbedURL(t *testing.T) {
	html := `<link rel="alternate" type="application/json+oembed" href="https://example.com/oembed?url=x&amp;format=json">`
	got := discoverOEmbedURL(html)
	want := "https://example.com/oembed?url=x&format=json"
	if got != want {
		t.Errorf("got %q want %q", got, want)
	}

	// reversed attribute order
	html2 := `<link href="https://example.com/oembed?url=y" type="application/json+oembed" rel="alternate">`
	got2 := discoverOEmbedURL(html2)
	want2 := "https://example.com/oembed?url=y"
	if got2 != want2 {
		t.Errorf("reversed: got %q want %q", got2, want2)
	}
}

func TestEmbedSource(t *testing.T) {
	cases := map[string]string{
		"https://kodik.biz/video/1/720p":       "kodik",
		"https://alloha.tv/embed/1":            "alloha",
		"https://sibnet.ru/video/player/x":     "sibnet",
		"https://cdn.example.com/live.m3u8":    "hls",
		"https://vk.com/video_ext.php?oid=1":   "embed",
		"https://player.vimeo.com/video/1":     "embed",
	}
	for url, want := range cases {
		if got := embedSource(url); got != want {
			t.Errorf("embedSource(%q) = %q, want %q", url, got, want)
		}
	}
}

func TestHostIsDead(t *testing.T) {
	// .invalid is an RFC 2606 reserved TLD that never resolves (NXDOMAIN).
	if !hostIsDead("syncwatch-test-never-resolves.invalid") {
		t.Error("expected .invalid host to be dead (NXDOMAIN)")
	}
	if hostIsDead("example.com") {
		t.Error("example.com should resolve")
	}
	if hostIsDead("") {
		t.Error("empty host should not be dead")
	}
}


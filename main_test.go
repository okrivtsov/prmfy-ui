package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func TestHandleAuthCallbackWithoutOIDCConfig(t *testing.T) {
	server := &Server{cfg: &Config{}}
	req := httptest.NewRequest(http.MethodGet, "/auth/callback?state=expected", nil)
	req.AddCookie(&http.Cookie{Name: oauthStateCookie, Value: "expected"})
	rec := httptest.NewRecorder()

	defer func() {
		if recovered := recover(); recovered != nil {
			t.Fatalf("handleAuthCallback panicked: %v", recovered)
		}
	}()

	server.handleAuthCallback(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected %d, got %d", http.StatusInternalServerError, rec.Code)
	}

	if !strings.Contains(rec.Body.String(), "OIDC not configured") {
		t.Fatalf("expected OIDC configuration error, got %q", rec.Body.String())
	}
}

func TestHandlePingTreatsNon2xxAsFailure(t *testing.T) {
	server := &Server{
		cfg: &Config{PermifyURL: "http://permify.local"},
		permifyHTTPClient: &http.Client{
			Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if r.URL.Path != "/healthz" {
					t.Fatalf("expected request path /healthz, got %q", r.URL.Path)
				}

				return &http.Response{
					StatusCode: http.StatusUnauthorized,
					Status:     "401 Unauthorized",
					Body:       io.NopCloser(strings.NewReader("unauthorized")),
					Header:     make(http.Header),
				}, nil
			}),
		},
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/internal/ping", nil)

	server.handlePing(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("expected %d, got %d", http.StatusBadGateway, rec.Code)
	}

	if !strings.Contains(rec.Body.String(), "401 Unauthorized") {
		t.Fatalf("expected upstream status in body, got %q", rec.Body.String())
	}
}

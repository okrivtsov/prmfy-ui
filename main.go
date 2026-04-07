package main

import (
	"context"
	"crypto/rand"
	"embed"
	"encoding/base64"
	"encoding/json"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
	"gopkg.in/yaml.v3"
)

type OIDCConfig struct {
	Issuer       string `yaml:"issuer"`
	Name         string `yaml:"name"`
	ClientID     string `yaml:"client_id"`
	ClientSecret string `yaml:"client_secret"`
	RedirectURL  string `yaml:"redirect_url"`
}

type AuthConfig struct {
	Enabled      bool       `yaml:"enabled"`
	OIDC         OIDCConfig `yaml:"oidc"`
	AllowedUsers []string   `yaml:"allowed_users"`
}

type APIEndpointRule struct {
	Method string `yaml:"method"`
	Path   string `yaml:"path"`
}

type APIAccessConfig struct {
	AllowedEndpoints []APIEndpointRule `yaml:"allowed_endpoints"`
}

type Config struct {
	PermifyURL    string          `yaml:"permify_url"`
	PermifyToken  string          `yaml:"permify_token"`
	PermifyTenant string          `yaml:"permify_tenant"`
	Auth          AuthConfig      `yaml:"auth"`
	APIAccess     APIAccessConfig `yaml:"api_access"`
}

func loadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var cfg Config
	return &cfg, yaml.Unmarshal(data, &cfg)
}

func main() {
	cfgPath := "config.yaml"
	if len(os.Args) > 1 {
		cfgPath = os.Args[1]
	}

	cfg, err := loadConfig(cfgPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	target, err := url.Parse(cfg.PermifyURL)
	if err != nil {
		log.Fatalf("invalid permify_url: %v", err)
	}

	proxy := httputil.NewSingleHostReverseProxy(target)
	upstreamTransport := newPermifyTransport()
	proxy.Transport = upstreamTransport
	orig := proxy.Director
	proxy.Director = func(req *http.Request) {
		orig(req)
		req.Header.Del("Cookie")
		req.Header.Del("Authorization")

		if cfg.PermifyToken != "" {
			req.Header.Set("Authorization", "Bearer "+cfg.PermifyToken)
		}
	}

	allowedAPI, err := buildAllowedAPISet(cfg)
	if err != nil {
		log.Fatalf("api_access: %v", err)
	}

	server := &Server{
		cfg:               cfg,
		proxy:             proxy,
		allowedAPI:        allowedAPI,
		permifyHTTPClient: &http.Client{Timeout: permifyRequestTimeout, Transport: upstreamTransport},
	}

	if cfg.Auth.Enabled && cfg.Auth.OIDC.Issuer != "" {
		provider, err := oidc.NewProvider(context.Background(), cfg.Auth.OIDC.Issuer)
		if err != nil {
			log.Fatalf("OIDC provider: %v", err)
		}

		server.oidcProvider = provider
		server.oauth2Config = &oauth2.Config{
			ClientID:     cfg.Auth.OIDC.ClientID,
			ClientSecret: cfg.Auth.OIDC.ClientSecret,
			RedirectURL:  cfg.Auth.OIDC.RedirectURL,
			Endpoint:     provider.Endpoint(),
			Scopes:       []string{oidc.ScopeOpenID, "email", "profile"},
		}
	}

	log.Println("listening on :8080")
	httpServer := &http.Server{
		Addr:              ":8080",
		Handler:           server.routes(),
		ReadHeaderTimeout: serverReadHeaderTimeout,
		ReadTimeout:       serverReadTimeout,
		WriteTimeout:      serverWriteTimeout,
		IdleTimeout:       serverIdleTimeout,
	}

	if err := httpServer.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

//go:embed dist
var distFiles embed.FS

const sessionCookie = "session"
const oauthStateCookie = "oauth_state"

const (
	sessionTTL                   = 12 * time.Hour
	oauthStateTTL                = 10 * time.Minute
	serverReadHeaderTimeout      = 5 * time.Second
	serverReadTimeout            = 15 * time.Second
	serverWriteTimeout           = 30 * time.Second
	serverIdleTimeout            = 60 * time.Second
	permifyDialTimeout           = 5 * time.Second
	permifyTLSHandshakeTimeout   = 5 * time.Second
	permifyResponseHeaderTimeout = 15 * time.Second
	permifyRequestTimeout        = 30 * time.Second
)

type sessionRecord struct {
	Email     string
	ExpiresAt time.Time
}

var (
	sessionMu sync.RWMutex
	sessions  = map[string]sessionRecord{}
)

type Server struct {
	cfg               *Config
	proxy             *httputil.ReverseProxy
	oidcProvider      *oidc.Provider
	oauth2Config      *oauth2.Config
	allowedAPI        map[string]map[string]struct{}
	permifyHTTPClient *http.Client
}

func newPermifyTransport() *http.Transport {
	return &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: permifyDialTimeout, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   permifyTLSHandshakeTimeout,
		ExpectContinueTimeout: 1 * time.Second,
		ResponseHeaderTimeout: permifyResponseHeaderTimeout,
	}
}

func buildAllowedAPISet(cfg *Config) (map[string]map[string]struct{}, error) {
	rules := cfg.APIAccess.AllowedEndpoints
	if len(rules) == 0 {
		return nil, &configError{
			field:   "api_access.allowed_endpoints",
			message: "at least one endpoint is required",
		}
	}

	allowed := make(map[string]map[string]struct{}, len(rules))
	for _, rule := range rules {
		method := strings.ToUpper(strings.TrimSpace(rule.Method))
		path := strings.TrimSpace(strings.ReplaceAll(rule.Path, "{tenant}", cfg.PermifyTenant))

		if method == "" {
			return nil, &configError{field: "api_access.allowed_endpoints.method", message: "method is required"}
		}

		if path == "" {
			return nil, &configError{field: "api_access.allowed_endpoints.path", message: "path is required"}
		}

		if !strings.HasPrefix(path, "/") {
			return nil, &configError{field: "api_access.allowed_endpoints.path", message: "path must start with /"}
		}

		if allowed[method] == nil {
			allowed[method] = map[string]struct{}{}
		}
		allowed[method][path] = struct{}{}
	}

	return allowed, nil
}

func (s *Server) isAllowedAPI(method, path string) bool {
	allowedByMethod, ok := s.allowedAPI[strings.ToUpper(method)]
	if !ok {
		return false
	}

	_, ok = allowedByMethod[path]
	return ok
}

type configError struct {
	field   string
	message string
}

func (e *configError) Error() string {
	return e.field + ": " + e.message
}

func newToken(size int) (string, error) {
	b := make([]byte, size)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}

	return base64.URLEncoding.EncodeToString(b), nil
}

func newSession(email string) (string, error) {
	token, err := newToken(32)
	if err != nil {
		return "", err
	}

	sessionMu.Lock()
	defer sessionMu.Unlock()
	sessions[token] = sessionRecord{
		Email:     email,
		ExpiresAt: time.Now().Add(sessionTTL),
	}
	return token, nil
}

func deleteSession(token string) {
	sessionMu.Lock()
	defer sessionMu.Unlock()
	delete(sessions, token)
}

func getSession(r *http.Request) (string, bool) {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return "", false
	}

	sessionMu.RLock()
	session, ok := sessions[c.Value]
	sessionMu.RUnlock()
	if !ok {
		return "", false
	}

	if time.Now().After(session.ExpiresAt) {
		deleteSession(c.Value)
		return "", false
	}

	return session.Email, true
}

func shouldUseSecureCookies(r *http.Request) bool {
	host := r.Host
	if parsedHost, _, err := net.SplitHostPort(host); err == nil {
		host = parsedHost
	}

	host = strings.Trim(host, "[]")
	return host != "localhost" && host != "127.0.0.1" && host != "::1"
}

func setAuthCookie(w http.ResponseWriter, r *http.Request, name, value string, ttl time.Duration) {
	cookie := &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   shouldUseSecureCookies(r),
	}

	if ttl > 0 {
		expiresAt := time.Now().Add(ttl)
		cookie.Expires = expiresAt
		cookie.MaxAge = int(ttl.Seconds())
	}

	http.SetCookie(w, cookie)
}

func clearAuthCookie(w http.ResponseWriter, r *http.Request, name string) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   shouldUseSecureCookies(r),
		MaxAge:   -1,
		Expires:  time.Unix(0, 0),
	})
}

func (s *Server) authRequired(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.cfg.Auth.Enabled {
			next(w, r)
			return
		}

		if _, ok := getSession(r); !ok {
			http.Redirect(w, r, "/auth/login", http.StatusFound)
			return
		}

		next(w, r)
	}
}

func (s *Server) handleAuthConfig(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, map[string]any{
		"provider":    s.cfg.Auth.OIDC.Name,
		"permify_url": s.cfg.PermifyURL,
		"tenant":      s.cfg.PermifyTenant,
	})
}

func (s *Server) handleAuthMe(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.Auth.Enabled {
		writeJSON(w, map[string]string{"email": ""})
		return
	}

	email, ok := getSession(r)
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	writeJSON(w, map[string]string{"email": email})
}

func (s *Server) handleAuthLogin(w http.ResponseWriter, r *http.Request) {
	if s.oauth2Config == nil {
		http.Error(w, "OIDC not configured", http.StatusInternalServerError)
		return
	}

	stateStr, err := newToken(16)
	if err != nil {
		http.Error(w, "failed to generate oauth state", http.StatusInternalServerError)
		return
	}

	setAuthCookie(w, r, oauthStateCookie, stateStr, oauthStateTTL)
	http.Redirect(
		w,
		r,
		s.oauth2Config.AuthCodeURL(
			stateStr,
			oauth2.SetAuthURLParam("prompt", "select_account"),
		),
		http.StatusFound,
	)
}

func (s *Server) handleAuthCallback(w http.ResponseWriter, r *http.Request) {
	stateCookie, err := r.Cookie(oauthStateCookie)
	if err != nil || stateCookie.Value != r.URL.Query().Get("state") {
		http.Error(w, "invalid state", http.StatusBadRequest)
		return
	}

	token, err := s.oauth2Config.Exchange(r.Context(), r.URL.Query().Get("code"))
	if err != nil {
		http.Error(w, "token exchange failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok {
		http.Error(w, "no id_token", http.StatusInternalServerError)
		return
	}

	verifier := s.oidcProvider.Verifier(&oidc.Config{ClientID: s.cfg.Auth.OIDC.ClientID})
	idToken, err := verifier.Verify(r.Context(), rawIDToken)
	if err != nil {
		http.Error(w, "token verification failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	var claims struct {
		Email         string `json:"email"`
		EmailVerified bool   `json:"email_verified"`
	}

	if err := idToken.Claims(&claims); err != nil {
		http.Error(w, "claims error: "+err.Error(), http.StatusInternalServerError)
		return
	}

	if !claims.EmailVerified {
		http.Error(w, "email is not verified", http.StatusForbidden)
		return
	}

	if len(s.cfg.Auth.AllowedUsers) > 0 {
		allowed := false
		for _, u := range s.cfg.Auth.AllowedUsers {
			if u == claims.Email {
				allowed = true
				break
			}
		}
		if !allowed {
			http.Error(w, "access denied", http.StatusForbidden)
			return
		}
	}

	sessionToken, err := newSession(claims.Email)
	if err != nil {
		http.Error(w, "failed to create session", http.StatusInternalServerError)
		return
	}

	clearAuthCookie(w, r, oauthStateCookie)
	setAuthCookie(w, r, sessionCookie, sessionToken, sessionTTL)
	http.Redirect(w, r, "/", http.StatusFound)
}

func (s *Server) handleAuthLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if c, err := r.Cookie(sessionCookie); err == nil {
		deleteSession(c.Value)
	}

	clearAuthCookie(w, r, sessionCookie)
	http.Redirect(w, r, "/", http.StatusFound)
}

func (s *Server) handlePing(w http.ResponseWriter, _ *http.Request) {
	req, err := http.NewRequest("GET", s.cfg.PermifyURL, nil)
	if err != nil {
		http.Error(w, "cannot build request to Permify", http.StatusInternalServerError)
		return
	}

	if s.cfg.PermifyToken != "" {
		req.Header.Set("Authorization", "Bearer "+s.cfg.PermifyToken)
	}

	resp, err := s.permifyHTTPClient.Do(req)
	if err != nil {
		http.Error(w, "cannot connect to Permify", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	w.WriteHeader(http.StatusOK)
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/auth/config", s.handleAuthConfig)
	mux.HandleFunc("/auth/me", s.handleAuthMe)
	mux.HandleFunc("/auth/login", s.handleAuthLogin)
	mux.HandleFunc("/auth/callback", s.handleAuthCallback)
	mux.HandleFunc("/auth/logout", s.handleAuthLogout)

	mux.HandleFunc("/internal/ping", s.authRequired(s.handlePing))

	mux.Handle("/api/", s.authRequired(func(w http.ResponseWriter, r *http.Request) {
		proxyPath := strings.TrimPrefix(r.URL.Path, "/api")
		if !s.isAllowedAPI(r.Method, proxyPath) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}

		r.URL.Path = proxyPath
		s.proxy.ServeHTTP(w, r)
	}))

	sub, err := fs.Sub(distFiles, "dist")
	if err != nil {
		panic(err)
	}

	static := http.FileServer(http.FS(sub))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p == "" {
			p = "index.html"
		}

		f, err := sub.Open(p)
		if err == nil {
			f.Close()
			static.ServeHTTP(w, r)
			return
		}

		r2 := *r
		r2.URL.Path = "/"
		static.ServeHTTP(w, &r2)
	})

	return mux
}

func writeJSON(w http.ResponseWriter, payload any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(payload)
}

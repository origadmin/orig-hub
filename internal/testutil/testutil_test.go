package testutil

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

type failureRecorder struct {
	testing.TB
	failed bool
}

func newFailureRecorder() *failureRecorder {
	return &failureRecorder{TB: &testing.B{}}
}

func (r *failureRecorder) Errorf(format string, args ...interface{}) {
	r.failed = true
}

func (r *failureRecorder) Fatalf(format string, args ...interface{}) {
	r.failed = true
}

func TestMockHTTPServerBasic(t *testing.T) {
	srv := NewMockHTTPServer(MockHTTPServerConfig{
		ContentLength: 256,
	})
	defer srv.Close()

	resp, err := http.Get(srv.URL())
	if err != nil {
		t.Fatalf("GET request failed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected status 200, got %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("failed to read body: %v", err)
	}

	if len(body) != 256 {
		t.Errorf("expected body length 256, got %d", len(body))
	}

	if !bytes.Equal(body, srv.Data()) {
		t.Error("response body does not match server data")
	}
}

func TestMockHTTPServerRangeRequest(t *testing.T) {
	srv := NewMockHTTPServer(MockHTTPServerConfig{
		ContentLength: 1024,
		EnableRange:   true,
	})
	defer srv.Close()

	req, err := http.NewRequest("GET", srv.URL(), nil)
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}
	req.Header.Set("Range", "bytes=100-199")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("range request failed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusPartialContent {
		t.Errorf("expected status 206, got %d", resp.StatusCode)
	}

	contentRange := resp.Header.Get("Content-Range")
	expectedRange := "bytes 100-199/1024"
	if contentRange != expectedRange {
		t.Errorf("Content-Range: expected %q, got %q", expectedRange, contentRange)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("failed to read body: %v", err)
	}

	expected := srv.Data()[100:200]
	if !bytes.Equal(body, expected) {
		t.Errorf("range body mismatch: got %d bytes, expected %d bytes", len(body), len(expected))
	}
}

func TestMockHTTPServerContentDisposition(t *testing.T) {
	srv := NewMockHTTPServer(MockHTTPServerConfig{
		ContentLength:      64,
		ContentDisposition: `attachment; filename="test-file.bin"`,
	})
	defer srv.Close()

	resp, err := http.Get(srv.URL())
	if err != nil {
		t.Fatalf("GET request failed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	cd := resp.Header.Get("Content-Disposition")
	expected := `attachment; filename="test-file.bin"`
	if cd != expected {
		t.Errorf("Content-Disposition: expected %q, got %q", expected, cd)
	}
}

func TestMockHTTPServerSlowResponse(t *testing.T) {
	srv := NewSlowHTTPServer(SlowResponseConfig{
		TotalSize: 256,
		ChunkSize: 64,
		Delay:     10 * time.Millisecond,
	})
	defer srv.Close()

	start := time.Now()
	resp, err := http.Get(srv.URL)
	if err != nil {
		t.Fatalf("GET request failed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	_, _ = io.ReadAll(resp.Body)
	elapsed := time.Since(start)

	if elapsed < 30*time.Millisecond {
		t.Errorf("response was too fast: %v (expected at least 30ms with 3 delays)", elapsed)
	}
}

func TestMockHTTPServerRedirect(t *testing.T) {
	target := NewMockHTTPServer(MockHTTPServerConfig{
		ContentLength: 128,
	})
	defer target.Close()

	srv := NewMockHTTPServer(MockHTTPServerConfig{
		RedirectURL:  target.URL(),
		RedirectCode: http.StatusFound,
	})
	defer srv.Close()

	client := &http.Client{
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	resp, err := client.Get(srv.URL())
	if err != nil {
		t.Fatalf("GET request failed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusFound {
		t.Errorf("expected status 302, got %d", resp.StatusCode)
	}

	loc := resp.Header.Get("Location")
	if loc != target.URL() {
		t.Errorf("Location header: expected %q, got %q", target.URL(), loc)
	}
}

func TestMockHTTPServerCustomStatusCode(t *testing.T) {
	codes := []int{404, 500, 403, 503}
	for _, code := range codes {
		t.Run(strconv.Itoa(code), func(t *testing.T) {
			srv := NewMockHTTPServer(MockHTTPServerConfig{
				StatusCode: code,
			})
			defer srv.Close()

			resp, err := http.Get(srv.URL())
			if err != nil {
				t.Fatalf("GET request failed: %v", err)
			}
			defer func() { _ = resp.Body.Close() }()

			if resp.StatusCode != code {
				t.Errorf("expected status %d, got %d", code, resp.StatusCode)
			}
		})
	}
}

func TestMockHTTPServerRequestCount(t *testing.T) {
	srv := NewMockHTTPServer(MockHTTPServerConfig{
		ContentLength: 32,
	})
	defer srv.Close()

	for i := 0; i < 5; i++ {
		resp, err := http.Get(srv.URL())
		if err != nil {
			t.Fatalf("GET request %d failed: %v", i, err)
		}
		_ = resp.Body.Close()
	}

	if count := srv.RequestCount(); count != 5 {
		t.Errorf("expected 5 requests, got %d", count)
	}
}

func TestMockHTTPServerDisconnect(t *testing.T) {
	srv := NewDisconnectHTTPServer(DisconnectServerConfig{
		TotalSize:    1024,
		DisconnectAt: 512,
	})
	defer srv.Close()

	resp, err := http.Get(srv.URL)
	if err != nil {
		t.Fatalf("GET request failed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	body, err := io.ReadAll(resp.Body)
	if err == nil {
		t.Error("expected error reading from disconnected server, got nil")
	}

	if len(body) != 512 {
		t.Errorf("expected 512 bytes before disconnect, got %d", len(body))
	}
}

func TestParseRange(t *testing.T) {
	tests := []struct {
		header        string
		contentLength int64
		start         int64
		end           int64
		ok            bool
	}{
		{"bytes=0-99", 200, 0, 99, true},
		{"bytes=100-", 200, 100, 199, true},
		{"bytes=-50", 200, 150, 199, true},
		{"bytes=300-400", 200, 0, 0, false},
		{"invalid", 200, 0, 0, false},
	}

	for i, tt := range tests {
		t.Run(fmt.Sprintf("case_%d", i), func(t *testing.T) {
			start, end, ok := parseRange(tt.header, tt.contentLength)
			if ok != tt.ok {
				t.Errorf("ok: expected %v, got %v", tt.ok, ok)
			}
			if ok && (start != tt.start || end != tt.end) {
				t.Errorf("range: expected %d-%d, got %d-%d", tt.start, tt.end, start, end)
			}
		})
	}
}

func TestMockBTTrackerAnnounce(t *testing.T) {
	peers := MakePeers(3)
	srv := NewMockBTTracker(MockBTTrackerConfig{
		Interval:  1800,
		Peers:     peers,
		Complete:  10,
	})
	defer srv.Close()

	resp, err := http.Get(srv.URL() + "/announce")
	if err != nil {
		t.Fatalf("announce request failed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected status 200, got %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("failed to read body: %v", err)
	}

	bodyStr := string(body)
	if !strings.Contains(bodyStr, "8:complete") {
		t.Error("announce response missing complete field")
	}
	if !strings.Contains(bodyStr, "8:interval") {
		t.Error("announce response missing interval field")
	}
	if !strings.Contains(bodyStr, "5:peers") {
		t.Error("announce response missing peers field")
	}

	if srv.AnnounceCount() != 1 {
		t.Errorf("expected 1 announce count, got %d", srv.AnnounceCount())
	}
}

func TestMockBTTrackerScrape(t *testing.T) {
	srv := NewMockBTTracker(MockBTTrackerConfig{
		Complete:   5,
		Incomplete: 3,
	})
	defer srv.Close()

	resp, err := http.Get(srv.URL() + "/scrape")
	if err != nil {
		t.Fatalf("scrape request failed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected status 200, got %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("failed to read body: %v", err)
	}

	bodyStr := string(body)
	if !strings.Contains(bodyStr, "5:files") {
		t.Error("scrape response missing files field")
	}
	if !strings.Contains(bodyStr, "10:incomplete") {
		t.Error("scrape response missing incomplete field")
	}

	if srv.ScrapeCount() != 1 {
		t.Errorf("expected 1 scrape count, got %d", srv.ScrapeCount())
	}
}

func TestMakePeersAndParse(t *testing.T) {
	peers := MakePeers(5)
	encoded := encodePeers(peers)
	parsed := ParseCompactPeers(encoded)

	if len(parsed) != 5 {
		t.Fatalf("expected 5 peers, got %d", len(parsed))
	}

	for i, p := range parsed {
		expected := peers[i]
		if !p.IP.Equal(expected.IP) {
			t.Errorf("peer %d IP: expected %v, got %v", i, expected.IP, p.IP)
		}
		if p.Port != expected.Port {
			t.Errorf("peer %d Port: expected %d, got %d", i, expected.Port, p.Port)
		}
	}
}

func TestMakePeersEncoding(t *testing.T) {
	peers := []PeerInfo{
		{IP: net.IPv4(127, 0, 0, 1), Port: 6881},
		{IP: net.IPv4(192, 168, 1, 1), Port: 6889},
	}

	encoded := encodePeers(peers)
	if len(encoded) != 12 {
		t.Errorf("expected 12 bytes for 2 peers, got %d", len(encoded))
	}

	parsed := ParseCompactPeers(encoded)
	if len(parsed) != 2 {
		t.Fatalf("expected 2 parsed peers, got %d", len(parsed))
	}

	if !parsed[0].IP.Equal(net.IPv4(127, 0, 0, 1)) {
		t.Errorf("peer 0 IP: expected 127.0.0.1, got %v", parsed[0].IP)
	}
	if parsed[0].Port != 6881 {
		t.Errorf("peer 0 Port: expected 6881, got %d", parsed[0].Port)
	}
}

func TestMockIPFSGatewayResolve(t *testing.T) {
	gw := NewMockIPFSGateway(MockIPFSGatewayConfig{})
	defer gw.Close()

	testData := []byte("hello ipfs world")
	testCID := "QmTestCID123456789"
	gw.AddCIDData(testCID, testData)

	resp, err := http.Get(gw.URL() + "/ipfs/" + testCID)
	if err != nil {
		t.Fatalf("resolve request failed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected status 200, got %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("failed to read body: %v", err)
	}

	if !bytes.Equal(body, testData) {
		t.Errorf("body mismatch: expected %q, got %q", testData, body)
	}
}

func TestMockIPFSGatewayNotFound(t *testing.T) {
	gw := NewMockIPFSGateway(MockIPFSGatewayConfig{})
	defer gw.Close()

	resp, err := http.Get(gw.URL() + "/ipfs/nonexistent")
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("expected status 404, got %d", resp.StatusCode)
	}
}

func TestMockIPFSGatewayPinAdd(t *testing.T) {
	gw := NewMockIPFSGateway(MockIPFSGatewayConfig{})
	defer gw.Close()

	testCID := "QmPinTestCID"
	gw.AddCIDData(testCID, []byte("pinned data"))

	resp, err := http.Get(gw.URL() + "/api/v0/pin/add?arg=" + testCID)
	if err != nil {
		t.Fatalf("pin add request failed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected status 200, got %d", resp.StatusCode)
	}
}

func TestMockIPFSGatewayPinRemove(t *testing.T) {
	gw := NewMockIPFSGateway(MockIPFSGatewayConfig{})
	defer gw.Close()

	testCID := "QmPinRmTestCID"
	gw.AddCIDData(testCID, []byte("data"))

	_, _ = http.Get(gw.URL() + "/api/v0/pin/add?arg=" + testCID)

	resp, err := http.Get(gw.URL() + "/api/v0/pin/rm?arg=" + testCID)
	if err != nil {
		t.Fatalf("pin remove request failed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected status 200, got %d", resp.StatusCode)
	}
}

func TestMockIPFSGatewayPinList(t *testing.T) {
	gw := NewMockIPFSGateway(MockIPFSGatewayConfig{})
	defer gw.Close()

	cid1 := "QmListCID1"
	cid2 := "QmListCID2"
	gw.AddCIDData(cid1, []byte("data1"))
	gw.AddCIDData(cid2, []byte("data2"))

	_, _ = http.Get(gw.URL() + "/api/v0/pin/add?arg=" + cid1)
	_, _ = http.Get(gw.URL() + "/api/v0/pin/add?arg=" + cid2)

	resp, err := http.Get(gw.URL() + "/api/v0/pin/ls")
	if err != nil {
		t.Fatalf("pin list request failed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected status 200, got %d", resp.StatusCode)
	}
}

func TestMockIPFSGatewayCat(t *testing.T) {
	gw := NewMockIPFSGateway(MockIPFSGatewayConfig{})
	defer gw.Close()

	testData := []byte("cat endpoint data")
	testCID := "QmCatCID"
	gw.AddCIDData(testCID, testData)

	resp, err := http.Get(gw.URL() + "/api/v0/cat?arg=" + testCID)
	if err != nil {
		t.Fatalf("cat request failed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected status 200, got %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("failed to read body: %v", err)
	}

	if !bytes.Equal(body, testData) {
		t.Errorf("body mismatch: expected %q, got %q", testData, body)
	}
}

func TestMockIPFSGatewayTimeout(t *testing.T) {
	gw := NewMockIPFSGateway(MockIPFSGatewayConfig{
		TimeoutDelay: 100 * time.Millisecond,
	})
	defer gw.Close()

	testCID := "QmTimeoutCID"
	gw.AddCIDData(testCID, []byte("slow data"))
	gw.SetTimeoutCID(testCID)

	client := &http.Client{Timeout: 50 * time.Millisecond}

	_, err := client.Get(gw.URL() + "/ipfs/" + testCID)
	if err == nil {
		t.Error("expected timeout error, got nil")
	}
}

func TestGenerateRandomFile(t *testing.T) {
	path, checksum := GenerateRandomFile(1024)
	defer func() { _ = os.RemoveAll(filepath.Dir(path)) }()

	AssertFileExists(t, path)
	AssertFileSize(t, path, 1024)

	actual := FileChecksum(path)
	if actual != checksum {
		t.Errorf("checksum mismatch: expected %s, got %s", checksum, actual)
	}
}

func TestGenerateRandomFileChecksumIntegrity(t *testing.T) {
	path, checksum := GenerateRandomFile(512)
	defer func() { _ = os.RemoveAll(filepath.Dir(path)) }()

	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("failed to open file: %v", err)
	}
	defer func() { _ = f.Close() }()

	hasher := sha256.New()
	if _, err := io.Copy(hasher, f); err != nil {
		t.Fatalf("failed to hash file: %v", err)
	}

	actual := hex.EncodeToString(hasher.Sum(nil))
	if actual != checksum {
		t.Errorf("checksum verification failed: expected %s, got %s", checksum, actual)
	}
}

func TestGenerateTestTorrent(t *testing.T) {
	path := GenerateTestTorrent("ubuntu", 4700000000)
	defer func() { _ = os.RemoveAll(filepath.Dir(path)) }()

	AssertFileExists(t, path)

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("failed to read torrent file: %v", err)
	}

	content := string(data)
	if !strings.Contains(content, "announce") {
		t.Error("torrent file missing announce field")
	}
	if !strings.Contains(content, "ubuntu") {
		t.Error("torrent file missing name field")
	}
}

func TestTempDir(t *testing.T) {
	dir := TempDir()

	info, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("temp dir does not exist: %v", err)
	}
	if !info.IsDir() {
		t.Error("temp dir is not a directory")
	}

	CleanupTempDirs()

	_, err = os.Stat(dir)
	if err == nil {
		t.Error("temp dir should have been cleaned up")
	}
}

func TestFileChecksum(t *testing.T) {
	dir := MustTempDir(t)
	path := filepath.Join(dir, "checksum_test.bin")
	content := []byte("test content for checksum")
	MustWriteFile(t, path, content)

	expected := sha256.Sum256(content)
	expectedHex := hex.EncodeToString(expected[:])

	actual := FileChecksum(path)
	if actual != expectedHex {
		t.Errorf("checksum mismatch: expected %s, got %s", expectedHex, actual)
	}
}

func TestFileChecksumNonexistent(t *testing.T) {
	result := FileChecksum("/nonexistent/path/file.bin")
	if result != "" {
		t.Errorf("expected empty checksum for nonexistent file, got %q", result)
	}
}

func TestFileSize(t *testing.T) {
	dir := MustTempDir(t)
	path := filepath.Join(dir, "size_test.bin")
	content := []byte("1234567890")
	MustWriteFile(t, path, content)

	size := FileSize(path)
	if size != int64(len(content)) {
		t.Errorf("file size: expected %d, got %d", len(content), size)
	}
}

func TestFileSizeNonexistent(t *testing.T) {
	size := FileSize("/nonexistent/path/file.bin")
	if size != -1 {
		t.Errorf("expected -1 for nonexistent file, got %d", size)
	}
}

func TestFileExists(t *testing.T) {
	dir := MustTempDir(t)
	path := filepath.Join(dir, "exists_test.bin")
	MustWriteFile(t, path, []byte("data"))

	if !FileExists(path) {
		t.Error("expected file to exist")
	}

	if FileExists(filepath.Join(dir, "nonexistent.bin")) {
		t.Error("expected nonexistent file to not exist")
	}
}

func TestAssertDownloadProgress(t *testing.T) {
	mockT := &testing.T{}

	AssertDownloadProgress(mockT, 50.0, 50.0)
	AssertDownloadProgress(mockT, 50.3, 50.0)
}

func TestAssertFileChecksumMismatch(t *testing.T) {
	dir := MustTempDir(t)
	path := filepath.Join(dir, "mismatch.bin")
	MustWriteFile(t, path, []byte("content"))

	rec := newFailureRecorder()
	AssertFileChecksum(rec, path, "wrongchecksum")
	if !rec.failed {
		t.Error("expected assertion to fail on checksum mismatch")
	}
}

func TestAssertFileSizeMismatch(t *testing.T) {
	dir := MustTempDir(t)
	path := filepath.Join(dir, "size_mismatch.bin")
	MustWriteFile(t, path, []byte("short"))

	rec := newFailureRecorder()
	AssertFileSize(rec, path, 1000)
	if !rec.failed {
		t.Error("expected assertion to fail on size mismatch")
	}
}

func TestAssertFileExistsAndNotExists(t *testing.T) {
	dir := MustTempDir(t)
	existingPath := filepath.Join(dir, "exists.bin")
	MustWriteFile(t, existingPath, []byte("data"))

	AssertFileExists(t, existingPath)
	AssertFileNotExists(t, filepath.Join(dir, "nope.bin"))
}

func TestMustTempDir(t *testing.T) {
	dir := MustTempDir(t)

	info, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("temp dir does not exist: %v", err)
	}
	if !info.IsDir() {
		t.Error("MustTempDir result is not a directory")
	}
}

func TestMustWriteAndReadFile(t *testing.T) {
	dir := MustTempDir(t)
	path := filepath.Join(dir, "rw_test.bin")
	content := []byte("read write test")

	MustWriteFile(t, path, content)
	read := MustReadFile(t, path)

	if !bytes.Equal(read, content) {
		t.Errorf("file content mismatch: expected %q, got %q", content, read)
	}
}

func TestCreateTestFile(t *testing.T) {
	dir := MustTempDir(t)
	content := []byte("test file content")
	path := CreateTestFile(t, dir, "created.bin", content)

	read, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("failed to read created file: %v", err)
	}
	if !bytes.Equal(read, content) {
		t.Errorf("content mismatch: expected %q, got %q", content, read)
	}
}

func TestMakeTrackerURL(t *testing.T) {
	url := MakeTrackerURL("http://tracker.example.com", "infohash123", "peerid456", 6881)
	if !strings.Contains(url, "http://tracker.example.com/announce") {
		t.Error("tracker URL missing announce endpoint")
	}
	if !strings.Contains(url, "info_hash=infohash123") {
		t.Error("tracker URL missing info_hash")
	}
	if !strings.Contains(url, "peer_id=peerid456") {
		t.Error("tracker URL missing peer_id")
	}
	if !strings.Contains(url, "port=6881") {
		t.Error("tracker URL missing port")
	}
	if !strings.Contains(url, "compact=1") {
		t.Error("tracker URL missing compact flag")
	}
}

package testutil

import (
	"encoding/binary"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
)

type PeerInfo struct {
	IP   net.IP
	Port uint16
}

type MockBTTrackerConfig struct {
	Interval    int
	MinInterval int
	Peers       []PeerInfo
	Complete    int
	Incomplete  int
}

type MockBTTracker struct {
	Server        *httptest.Server
	Config        MockBTTrackerConfig
	announceCount int
	scrapeCount   int
}

func NewMockBTTracker(cfg MockBTTrackerConfig) *MockBTTracker {
	if cfg.Interval <= 0 {
		cfg.Interval = 1800
	}
	if cfg.MinInterval <= 0 {
		cfg.MinInterval = 300
	}

	m := &MockBTTracker{Config: cfg}

	mux := http.NewServeMux()
	mux.HandleFunc("/announce", m.handleAnnounce)
	mux.HandleFunc("/scrape", m.handleScrape)

	m.Server = httptest.NewServer(mux)
	return m
}

func (m *MockBTTracker) URL() string {
	return m.Server.URL
}

func (m *MockBTTracker) AnnounceCount() int {
	return m.announceCount
}

func (m *MockBTTracker) ScrapeCount() int {
	return m.scrapeCount
}

func (m *MockBTTracker) Close() {
	m.Server.Close()
}

func (m *MockBTTracker) handleAnnounce(w http.ResponseWriter, r *http.Request) {
	m.announceCount++

	w.Header().Set("Content-Type", "text/plain")

	peerBytes := encodePeers(m.Config.Peers)

	response := fmt.Sprintf(
		"d8:completei%de10:downloadedi0de8:intervali%de12:min intervali%de5:peers%d:%se",
		m.Config.Complete,
		m.Config.Interval,
		m.Config.MinInterval,
		len(peerBytes),
		peerBytes,
	)

	_, _ = w.Write([]byte(response))
}

func (m *MockBTTracker) handleScrape(w http.ResponseWriter, r *http.Request) {
	m.scrapeCount++

	w.Header().Set("Content-Type", "text/plain")

	infoHash := r.URL.Query().Get("info_hash")
	if infoHash == "" {
		infoHash = "\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00"
	}

	response := fmt.Sprintf(
		"d5:filesd20:%sd8:completei%de10:downloadedi0de10:incompletei%deeee",
		infoHash,
		m.Config.Complete,
		m.Config.Incomplete,
	)

	_, _ = w.Write([]byte(response))
}

func encodePeers(peers []PeerInfo) []byte {
	buf := make([]byte, len(peers)*6)
	for i, p := range peers {
		copy(buf[i*6:i*6+4], p.IP.To4())
		binary.BigEndian.PutUint16(buf[i*6+4:i*6+6], p.Port)
	}
	return buf
}

func MakePeers(count int) []PeerInfo {
	peers := make([]PeerInfo, count)
	for i := 0; i < count; i++ {
		ip := net.IPv4(10, 0, byte(i/256), byte(i%256))
		port := uint16(6881 + i)
		peers[i] = PeerInfo{IP: ip, Port: port}
	}
	return peers
}

func ParseCompactPeers(data []byte) []PeerInfo {
	if len(data)%6 != 0 {
		return nil
	}
	count := len(data) / 6
	peers := make([]PeerInfo, count)
	for i := 0; i < count; i++ {
		peers[i] = PeerInfo{
			IP:   net.IPv4(data[i*6], data[i*6+1], data[i*6+2], data[i*6+3]),
			Port: binary.BigEndian.Uint16(data[i*6+4 : i*6+6]),
		}
	}
	return peers
}

func MakeTrackerURL(baseURL string, infoHash string, peerID string, port int) string {
	return fmt.Sprintf(
		"%s/announce?info_hash=%s&peer_id=%s&port=%s&uploaded=0&downloaded=0&left=0&compact=1",
		baseURL,
		infoHash,
		peerID,
		strconv.Itoa(port),
	)
}

package protocol_test

import (
	"testing"

	"github.com/origadmin/orig-hub/internal/protocol"
)

func TestNewCapabilitySetNoCaps(t *testing.T) {
	cs := protocol.NewCapabilitySet()
	if cs != 0 {
		t.Errorf("NewCapabilitySet() = %d, want 0", cs)
	}
}

func TestNewCapabilitySetSingleCap(t *testing.T) {
	cs := protocol.NewCapabilitySet(protocol.CapPauseResume)
	if !cs.Has(protocol.CapPauseResume) {
		t.Error("expected CapPauseResume to be set")
	}
	if cs.Has(protocol.CapMirrors) {
		t.Error("expected CapMirrors to not be set")
	}
}

func TestNewCapabilitySetMultipleCaps(t *testing.T) {
	cs := protocol.NewCapabilitySet(protocol.CapPauseResume, protocol.CapMirrors, protocol.CapStreaming)

	if !cs.Has(protocol.CapPauseResume) {
		t.Error("expected CapPauseResume to be set")
	}
	if !cs.Has(protocol.CapMirrors) {
		t.Error("expected CapMirrors to be set")
	}
	if !cs.Has(protocol.CapStreaming) {
		t.Error("expected CapStreaming to be set")
	}
	if cs.Has(protocol.CapUpload) {
		t.Error("expected CapUpload to not be set")
	}
}

func TestAddCap(t *testing.T) {
	cs := protocol.NewCapabilitySet(protocol.CapPauseResume)
	cs = cs.Add(protocol.CapMirrors)

	if !cs.Has(protocol.CapPauseResume) {
		t.Error("expected CapPauseResume to still be set after Add")
	}
	if !cs.Has(protocol.CapMirrors) {
		t.Error("expected CapMirrors to be set after Add")
	}
}

func TestRemoveCap(t *testing.T) {
	cs := protocol.NewCapabilitySet(protocol.CapPauseResume, protocol.CapMirrors)
	cs = cs.Remove(protocol.CapMirrors)

	if !cs.Has(protocol.CapPauseResume) {
		t.Error("expected CapPauseResume to still be set after Remove")
	}
	if cs.Has(protocol.CapMirrors) {
		t.Error("expected CapMirrors to not be set after Remove")
	}
}

func TestHasOnEmptySet(t *testing.T) {
	cs := protocol.NewCapabilitySet()
	if cs.Has(protocol.CapPauseResume) {
		t.Error("expected Has to return false on empty set")
	}
	if cs.Has(protocol.CapStreaming) {
		t.Error("expected Has to return false on empty set")
	}
}

func TestAllReturnsSetCapabilities(t *testing.T) {
	cs := protocol.NewCapabilitySet(protocol.CapPauseResume, protocol.CapChunkBased, protocol.CapDHT)
	all := cs.All()

	if len(all) != 3 {
		t.Fatalf("All() returned %d caps, want 3", len(all))
	}

	hasPauseResume := false
	hasChunkBased := false
	hasDHT := false
	for _, c := range all {
		switch c {
		case protocol.CapPauseResume:
			hasPauseResume = true
		case protocol.CapChunkBased:
			hasChunkBased = true
		case protocol.CapDHT:
			hasDHT = true
		}
	}
	if !hasPauseResume {
		t.Error("All() missing CapPauseResume")
	}
	if !hasChunkBased {
		t.Error("All() missing CapChunkBased")
	}
	if !hasDHT {
		t.Error("All() missing CapDHT")
	}
}

func TestAllOnEmptySet(t *testing.T) {
	cs := protocol.NewCapabilitySet()
	all := cs.All()
	if len(all) != 0 {
		t.Errorf("All() on empty set returned %d caps, want 0", len(all))
	}
}

func TestStringFormat(t *testing.T) {
	cs := protocol.NewCapabilitySet(protocol.CapPauseResume, protocol.CapMirrors, protocol.CapChunkBased)
	got := cs.String()
	want := "PauseResume|Mirrors|ChunkBased"
	if got != want {
		t.Errorf("String() = %q, want %q", got, want)
	}
}

func TestStringOnEmptySet(t *testing.T) {
	cs := protocol.NewCapabilitySet()
	got := cs.String()
	if got != "None" {
		t.Errorf("String() on empty set = %q, want %q", got, "None")
	}
}

func TestStringSingleCap(t *testing.T) {
	cs := protocol.NewCapabilitySet(protocol.CapUpload)
	got := cs.String()
	if got != "Upload" {
		t.Errorf("String() = %q, want %q", got, "Upload")
	}
}

func TestAddAndRemoveChainable(t *testing.T) {
	cs := protocol.NewCapabilitySet(protocol.CapPauseResume)
	cs = cs.Add(protocol.CapMirrors).Add(protocol.CapStreaming)
	cs = cs.Remove(protocol.CapMirrors)

	if !cs.Has(protocol.CapPauseResume) {
		t.Error("expected CapPauseResume to be set")
	}
	if cs.Has(protocol.CapMirrors) {
		t.Error("expected CapMirrors to be removed")
	}
	if !cs.Has(protocol.CapStreaming) {
		t.Error("expected CapStreaming to be set")
	}
}

func TestAddIdempotent(t *testing.T) {
	cs := protocol.NewCapabilitySet(protocol.CapPauseResume)
	cs = cs.Add(protocol.CapPauseResume)

	if !cs.Has(protocol.CapPauseResume) {
		t.Error("expected CapPauseResume to still be set")
	}
}

func TestRemoveNonExistent(t *testing.T) {
	cs := protocol.NewCapabilitySet(protocol.CapPauseResume)
	cs = cs.Remove(protocol.CapDHT)

	if !cs.Has(protocol.CapPauseResume) {
		t.Error("expected CapPauseResume to still be set after removing non-existent cap")
	}
	if cs.Has(protocol.CapDHT) {
		t.Error("expected CapDHT to not be set")
	}
}

func TestHTTPCapsCombination(t *testing.T) {
	cs := protocol.NewCapabilitySet(
		protocol.CapPauseResume,
		protocol.CapMirrors,
		protocol.CapChunkBased,
		protocol.CapMetadataProbe,
		protocol.CapStreaming,
	)

	if !cs.Has(protocol.CapPauseResume) {
		t.Error("HTTP: expected CapPauseResume")
	}
	if !cs.Has(protocol.CapMirrors) {
		t.Error("HTTP: expected CapMirrors")
	}
	if !cs.Has(protocol.CapChunkBased) {
		t.Error("HTTP: expected CapChunkBased")
	}
	if !cs.Has(protocol.CapMetadataProbe) {
		t.Error("HTTP: expected CapMetadataProbe")
	}
	if !cs.Has(protocol.CapStreaming) {
		t.Error("HTTP: expected CapStreaming")
	}
	if cs.Has(protocol.CapUpload) {
		t.Error("HTTP: did not expect CapUpload")
	}
	if cs.Has(protocol.CapDHT) {
		t.Error("HTTP: did not expect CapDHT")
	}

	got := cs.String()
	want := "PauseResume|Mirrors|Streaming|MetadataProbe|ChunkBased"
	if got != want {
		t.Errorf("HTTP String() = %q, want %q", got, want)
	}
}

func TestBTCapsCombination(t *testing.T) {
	cs := protocol.NewCapabilitySet(
		protocol.CapPauseResume,
		protocol.CapStreaming,
		protocol.CapUpload,
		protocol.CapChunkBased,
		protocol.CapDHT,
		protocol.CapMultiNode,
	)

	if !cs.Has(protocol.CapPauseResume) {
		t.Error("BT: expected CapPauseResume")
	}
	if !cs.Has(protocol.CapStreaming) {
		t.Error("BT: expected CapStreaming")
	}
	if !cs.Has(protocol.CapUpload) {
		t.Error("BT: expected CapUpload")
	}
	if !cs.Has(protocol.CapChunkBased) {
		t.Error("BT: expected CapChunkBased")
	}
	if !cs.Has(protocol.CapDHT) {
		t.Error("BT: expected CapDHT")
	}
	if !cs.Has(protocol.CapMultiNode) {
		t.Error("BT: expected CapMultiNode")
	}
	if cs.Has(protocol.CapMetadataProbe) {
		t.Error("BT: did not expect CapMetadataProbe")
	}
	if cs.Has(protocol.CapPinning) {
		t.Error("BT: did not expect CapPinning")
	}

	got := cs.String()
	want := "PauseResume|Streaming|Upload|ChunkBased|MultiNode|DHT"
	if got != want {
		t.Errorf("BT String() = %q, want %q", got, want)
	}
}

func TestAllCapabilityConstants(t *testing.T) {
	allCaps := []protocol.Capability{
		protocol.CapPauseResume,
		protocol.CapMirrors,
		protocol.CapStreaming,
		protocol.CapUpload,
		protocol.CapMetadataProbe,
		protocol.CapChunkBased,
		protocol.CapAuthSupport,
		protocol.CapMultiNode,
		protocol.CapDHT,
		protocol.CapPinning,
	}

	cs := protocol.NewCapabilitySet(allCaps...)
	all := cs.All()
	if len(all) != 10 {
		t.Errorf("All() with all caps = %d, want 10", len(all))
	}

	for _, c := range allCaps {
		if !cs.Has(c) {
			t.Errorf("expected capability %d to be set", c)
		}
	}
}

package protocol

import "strings"

type Capability uint64

const (
	CapPauseResume Capability = 1 << iota
	CapMirrors
	CapStreaming
	CapUpload
	CapMetadataProbe
	CapChunkBased
	CapAuthSupport
	CapMultiNode
	CapDHT
	CapPinning
)

var capabilityNames = map[Capability]string{
	CapPauseResume:   "PauseResume",
	CapMirrors:       "Mirrors",
	CapStreaming:     "Streaming",
	CapUpload:        "Upload",
	CapMetadataProbe: "MetadataProbe",
	CapChunkBased:    "ChunkBased",
	CapAuthSupport:   "AuthSupport",
	CapMultiNode:     "MultiNode",
	CapDHT:           "DHT",
	CapPinning:       "Pinning",
}

type CapabilitySet uint64

func NewCapabilitySet(caps ...Capability) CapabilitySet {
	var cs CapabilitySet
	for _, c := range caps {
		cs |= CapabilitySet(c)
	}
	return cs
}

func (cs CapabilitySet) Has(cap Capability) bool {
	return cs&CapabilitySet(cap) != 0
}

func (cs CapabilitySet) Add(cap Capability) CapabilitySet {
	return cs | CapabilitySet(cap)
}

func (cs CapabilitySet) Remove(cap Capability) CapabilitySet {
	return cs & ^CapabilitySet(cap)
}

func (cs CapabilitySet) All() []Capability {
	allCaps := []Capability{
		CapPauseResume,
		CapMirrors,
		CapStreaming,
		CapUpload,
		CapMetadataProbe,
		CapChunkBased,
		CapAuthSupport,
		CapMultiNode,
		CapDHT,
		CapPinning,
	}
	var result []Capability
	for _, c := range allCaps {
		if cs.Has(c) {
			result = append(result, c)
		}
	}
	return result
}

func (cs CapabilitySet) String() string {
	caps := cs.All()
	names := make([]string, 0, len(caps))
	for _, c := range caps {
		if name, ok := capabilityNames[c]; ok {
			names = append(names, name)
		}
	}
	if len(names) == 0 {
		return "None"
	}
	return strings.Join(names, "|")
}

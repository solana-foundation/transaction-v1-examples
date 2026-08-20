// Transaction message version identification.

package txv1

import "fmt"

// MessageVersion is the version of a transaction message.
type MessageVersion int

const (
	VersionLegacy MessageVersion = iota
	VersionV0
	VersionV1
)

func (v MessageVersion) String() string {
	switch v {
	case VersionV0:
		return "v0"
	case VersionV1:
		return "v1"
	default:
		return "legacy"
	}
}

// VersionTally is a running count of transaction versions, used by the block
// examples.
type VersionTally struct {
	Legacy uint64
	V0     uint64
	V1     uint64
}

func (t *VersionTally) Record(version MessageVersion) {
	switch version {
	case VersionV0:
		t.V0++
	case VersionV1:
		t.V1++
	default:
		t.Legacy++
	}
}

func (t VersionTally) Total() uint64 {
	return t.Legacy + t.V0 + t.V1
}

func (t VersionTally) String() string {
	return fmt.Sprintf("legacy=%d v0=%d v1=%d", t.Legacy, t.V0, t.V1)
}

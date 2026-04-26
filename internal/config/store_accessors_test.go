package config

import "testing"

func TestStoreHistorySplitAccessors(t *testing.T) {
	store := &Store{cfg: Config{}}
	if !store.HistorySplitEnabled() {
		t.Fatal("expected history split enabled by default")
	}
	if got := store.HistorySplitTriggerAfterTurns(); got != 1 {
		t.Fatalf("default history split trigger_after_turns=%d want=1", got)
	}

	enabled := false
	turns := 3
	store.cfg.HistorySplit = HistorySplitConfig{
		Enabled:           &enabled,
		TriggerAfterTurns: &turns,
	}

	if !store.HistorySplitEnabled() {
		t.Fatal("expected history split to stay enabled after legacy disabled override")
	}
	if got := store.HistorySplitTriggerAfterTurns(); got != 3 {
		t.Fatalf("history split trigger_after_turns=%d want=3", got)
	}
}

func TestStoreHistorySplitLegacyDisabledConfigNormalizesToEnabled(t *testing.T) {
	t.Setenv("DS2API_CONFIG_JSON", `{"keys":["k1"],"history_split":{"enabled":false,"trigger_after_turns":2}}`)
	store := LoadStore()
	if !store.HistorySplitEnabled() {
		t.Fatal("expected history split enabled when legacy config disables it")
	}
	snap := store.Snapshot()
	if snap.HistorySplit.Enabled == nil || !*snap.HistorySplit.Enabled {
		t.Fatalf("expected normalized history_split.enabled=true, got %#v", snap.HistorySplit.Enabled)
	}
	if got := store.HistorySplitTriggerAfterTurns(); got != 2 {
		t.Fatalf("history split trigger_after_turns=%d want=2", got)
	}
}

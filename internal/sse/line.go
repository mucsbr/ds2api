package sse

import (
	"fmt"

	"ds2api/internal/config"
	"ds2api/internal/util"
)

// LineResult is the normalized parse result for one DeepSeek SSE line.
type LineResult struct {
	Parsed                     bool
	Stop                       bool
	ContentFilter              bool
	ErrorMessage               string
	Parts                      []ContentPart
	ToolDetectionThinkingParts []ContentPart
	NextType                   string
	ResponseMessageID          int
	AccumulatedTokens          int // upstream accumulated_token_usage from DeepSeek SSE
}

// ParseDeepSeekContentLine centralizes one-line DeepSeek SSE parsing for both
// streaming and non-streaming handlers.
func ParseDeepSeekContentLine(raw []byte, thinkingEnabled bool, currentType string) LineResult {
	chunk, done, parsed := ParseDeepSeekSSELine(raw)
	if !parsed {
		return LineResult{NextType: currentType}
	}
	if done {
		return LineResult{Parsed: true, Stop: true, NextType: currentType}
	}
	if errObj, hasErr := chunk["error"]; hasErr {
		return LineResult{
			Parsed:       true,
			Stop:         true,
			ErrorMessage: fmt.Sprintf("%v", errObj),
			NextType:     currentType,
		}
	}
	if code, _ := chunk["code"].(string); code == "content_filter" {
		return LineResult{
			Parsed:        true,
			Stop:          true,
			ContentFilter: true,
			NextType:      currentType,
		}
	}
	if hasContentFilterStatus(chunk) {
		return LineResult{
			Parsed:        true,
			Stop:          true,
			ContentFilter: true,
			NextType:      currentType,
		}
	}
	parts, detectionThinkingParts, finished, nextType := ParseSSEChunkForContentDetailed(chunk, thinkingEnabled, currentType)
	parts = filterLeakedContentFilterParts(parts)
	detectionThinkingParts = filterLeakedContentFilterParts(detectionThinkingParts)
	var respMsgID int
	observeResponseMessageID(chunk, &respMsgID)
	accTokens := extractAccumulatedTokens(chunk)
	return LineResult{
		Parsed:                     true,
		Stop:                       finished,
		Parts:                      parts,
		ToolDetectionThinkingParts: detectionThinkingParts,
		NextType:                   nextType,
		ResponseMessageID:          respMsgID,
		AccumulatedTokens:          accTokens,
	}
}

func extractAccumulatedTokens(chunk map[string]any) int {
	if chunk == nil {
		return 0
	}
	// Check top-level keys first
	if v, ok := chunk["accumulated_token_usage"]; ok {
		val := util.IntFrom(v)
		config.Logger.Debug("[sse] extracted accumulated_token_usage from top-level", "value", val)
		return val
	}
	if v, ok := chunk["token_usage"]; ok {
		val := util.IntFrom(v)
		config.Logger.Debug("[sse] extracted token_usage from top-level", "value", val)
		return val
	}
	// Check nested inside v array (DeepSeek SSE batch format)
	if items, ok := chunk["v"].([]any); ok {
		for _, item := range items {
			if m, ok2 := item.(map[string]any); ok2 {
				if p, _ := m["p"].(string); p == "accumulated_token_usage" {
					val := util.IntFrom(m["v"])
					config.Logger.Debug("[sse] extracted accumulated_token_usage from v array", "value", val)
					return val
				}
			}
		}
	}
	return 0
}

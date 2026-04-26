package promptcompat

import (
	"fmt"
	"strings"

	"ds2api/internal/prompt"
)

const historySplitInjectedFilename = "IGNORE"

func BuildOpenAIHistoryTranscript(messages []any) string {
	normalized := NormalizeOpenAIMessagesForPrompt(messages, "")
	transcript := strings.TrimSpace(prompt.MessagesPrepare(normalized))
	if transcript == "" {
		return ""
	}
	return fmt.Sprintf("[file content end]\n\n%s\n\n[file name]: %s\n[file content begin]\n", transcript, historySplitInjectedFilename)
}

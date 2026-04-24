package toolcall

import (
	"strings"
	"testing"
)

func TestBuildToolCallInstructions_ExecCommandUsesCmdExample(t *testing.T) {
	out := BuildToolCallInstructions([]string{"exec_command"})
	if !strings.Contains(out, `<tool_name>exec_command</tool_name>`) {
		t.Fatalf("expected exec_command in examples, got: %s", out)
	}
	if !strings.Contains(out, `<parameters><cmd><![CDATA[pwd]]></cmd></parameters>`) {
		t.Fatalf("expected cmd parameter example for exec_command, got: %s", out)
	}
}

func TestBuildToolCallInstructions_RealFailureExamplesIncluded(t *testing.T) {
	out := BuildToolCallInstructions([]string{"read_file"})
	if !strings.Contains(out, `<tool_calls><read_file><path>README.md</path></read_file></tool_calls>`) {
		t.Fatalf("expected wrong example for tool-name-as-tag, got: %s", out)
	}
	if !strings.Contains(out, "<tool_call name=\"read_file`><parameters><path>README.md</path></parameters></tool_call>") {
		t.Fatalf("expected wrong example for malformed name attribute, got: %s", out)
	}
	if !strings.Contains(out, `<tool_call><tool_calls>...</tool_calls></tool_call>`) {
		t.Fatalf("expected wrong example for mixed wrappers, got: %s", out)
	}
}

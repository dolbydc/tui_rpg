import { useState } from "react";
import { Box, Text, useApp, useInput } from "ink";

export function App() {
  const { exit } = useApp();
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);

  useInput((char, key) => {
    if (key.escape || (key.ctrl && char === "c")) {
      exit();
      return;
    }
    if (key.return) {
      if (input.trim()) setHistory((h) => [...h.slice(-9), input]);
      setInput("");
      return;
    }
    if (key.backspace || key.delete) {
      setInput((s) => s.slice(0, -1));
      return;
    }
    if (char && !key.ctrl && !key.meta) setInput((s) => s + char);
  });

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold color="cyan">
        TUI RPG
      </Text>
      <Text dimColor>Type and press Enter to echo. Esc or Ctrl+C to quit.</Text>
      <Box flexDirection="column" marginY={1}>
        {history.map((line, i) => (
          <Text key={i}>
            <Text color="green">echo:</Text> {line}
          </Text>
        ))}
      </Box>
      <Text>
        <Text color="yellow">&gt; </Text>
        {input}
        <Text inverse> </Text>
      </Text>
    </Box>
  );
}

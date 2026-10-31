function newAssistant(id) {
  return { id, role: 'assistant', blocks: [], createdAt: Date.now() };
}

// One visible reply groups all model steps and tool calls for the user's turn.
class Transcript {
  constructor(message) {
    this.message = message;
    this.currentMessageId = null;
    this.streamBlocks = new Map();
  }

  stream(event) {
    if (event.type === 'message_start') this.currentMessageId = event.message.id;
    const key = `${this.currentMessageId}:${event.index}`;
    if (event.type === 'content_block_start') {
      const block = this.addBlock(event.content_block, this.currentMessageId);
      if (block) this.streamBlocks.set(key, block);
    }
    const block = this.streamBlocks.get(key);
    if (event.type === 'content_block_delta' && block) {
      if (event.delta.type === 'thinking_delta') block.text += event.delta.thinking;
      if (event.delta.type === 'text_delta') block.text += event.delta.text;
      if (event.delta.type === 'input_json_delta') {
        block.partialInput = (block.partialInput || '') + event.delta.partial_json;
        try { block.input = JSON.parse(block.partialInput); } catch { /* JSON is still streaming. */ }
      }
    }
  }

  addBlock(content, sourceId) {
    if (content.type === 'thinking') {
      const block = { type: 'thinking', text: content.thinking || '', sourceId };
      this.message.blocks.push(block);
      return block;
    }
    if (content.type === 'text') {
      const block = { type: 'text', text: content.text || '', sourceId };
      this.message.blocks.push(block);
      return block;
    }
    if (content.type === 'tool_use') {
      const existing = this.message.blocks.find(item => item.id === content.id);
      if (existing) return existing;
      const block = { type: 'tool', id: content.id, name: content.name, input: content.input || {}, status: 'running', sourceId };
      this.message.blocks.push(block);
      return block;
    }
  }

  assistant(event) {
    const sourceId = event.message.id;
    // Final assistant messages replace their streamed text instead of appending it twice.
    const texts = event.message.content.filter(block => block.type === 'text');
    if (texts.length) {
      const existing = this.message.blocks.filter(block => block.type === 'text' && block.sourceId === sourceId);
      texts.forEach((text, index) => {
        if (existing[index]) existing[index].text = text.text;
        else this.addBlock(text, sourceId);
      });
    }
    const thoughts = event.message.content.filter(block => block.type === 'thinking');
    const existingThoughts = this.message.blocks.filter(block => block.type === 'thinking' && block.sourceId === sourceId);
    thoughts.forEach((thought, index) => {
      if (existingThoughts[index]) existingThoughts[index].text = thought.thinking;
      else this.addBlock(thought, sourceId);
    });
    for (const content of event.message.content) {
      if (content.type !== 'tool_use') continue;
      const block = this.addBlock(content, sourceId);
      block.input = content.input;
      delete block.partialInput;
    }
    if (event.error) this.message.error = event.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  }

  toolResults(event) {
    if (!Array.isArray(event.message?.content)) return;
    for (const result of event.message.content) {
      if (result.type !== 'tool_result') continue;
      const block = this.message.blocks.find(item => item.id === result.tool_use_id);
      if (!block) continue;
      block.status = result.is_error ? 'error' : 'done';
      block.output = typeof result.content === 'string' ? result.content : JSON.stringify(result.content, null, 2);
      if (block.output?.length > 30000) block.output = block.output.slice(0, 30000) + '\n…输出已截断';
    }
  }

  consume(event) {
    // Subagent messages are represented by their parent tool, not merged into the main answer.
    if (event.parent_tool_use_id) return;
    if (event.type === 'stream_event') this.stream(event.event);
    if (event.type === 'assistant') this.assistant(event);
    if (event.type === 'user') this.toolResults(event);
    if (event.type === 'system' && event.subtype === 'local_command_output') this.addBlock({ type: 'text', text: event.content }, event.uuid);
    if (event.type === 'system' && event.subtype === 'compact_boundary') this.addBlock({ type: 'text', text: '上下文已压缩。' }, event.uuid);
    if (event.type === 'result') {
      if (event.is_error) this.message.error = event.result || event.errors?.join('\n') || '远端 Claude 返回错误';
      if (!this.message.blocks.some(b => b.type === 'text') && event.result && !event.is_error)
        this.addBlock({ type: 'text', text: event.result }, 'result');
      this.message.durationMs = event.duration_ms;
    }
  }
}
module.exports = { Transcript, newAssistant };

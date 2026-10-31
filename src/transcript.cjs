function outputText(content, limit = 30000) {
  const text = typeof content === 'string' ? content : Array.isArray(content) ?
    content.map(item => item?.type === 'text' ? item.text : item?.type === 'image' ? '[图片]' : JSON.stringify(item)).join('\n') :
    content === undefined || content === null ? '' : JSON.stringify(content, null, 2);
  return text.length > limit ? text.slice(0, limit) + '\n…输出已截断' : text;
}

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
    if (['tool_use', 'server_tool_use', 'mcp_tool_use'].includes(content.type)) {
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
      if (/_tool_result$/.test(content.type) && content.tool_use_id) { this.finishTool(content.tool_use_id, content.content, content.is_error); continue; }
      if (!['tool_use', 'server_tool_use', 'mcp_tool_use'].includes(content.type)) continue;
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
      this.finishTool(result.tool_use_id, result.content, result.is_error);
    }
  }

  finishTool(id, content, isError) {
    const block = this.message.blocks.find(item => item.id === id);
    if (!block) return;
    block.status = isError ? 'error' : 'done';
    block.output = outputText(content);
    delete block.elapsed;
  }

  notice(text, level = 'info') {
    this.message.blocks.push({ type: 'notice', text, level });
  }

  // A subagent's steps stay under the tool that launched it, never in the main answer.
  subagent(event) {
    const parent = this.message.blocks.find(item => item.id === event.parent_tool_use_id);
    if (!parent) return;
    parent.children ||= [];
    if (event.type === 'assistant') {
      for (const content of event.message?.content || []) {
        if (content.type === 'text' && content.text) parent.agentText = content.text.slice(-2000);
        if (content.type === 'tool_use' && parent.children.length < 200 && !parent.children.some(child => child.id === content.id))
          parent.children.push({ id: content.id, name: content.name, input: content.input || {}, status: 'running' });
      }
    }
    if (event.type === 'user' && Array.isArray(event.message?.content)) {
      for (const result of event.message.content) {
        const child = parent.children.find(item => item.id === result.tool_use_id);
        if (child) { child.status = result.is_error ? 'error' : 'done'; child.output = outputText(result.content, 4000); }
      }
    }
  }

  system(event) {
    delete this.message.activity;
    if (event.subtype === 'local_command_output') this.addBlock({ type: 'text', text: event.content }, event.uuid);
    if (event.subtype === 'compact_boundary') {
      const { pre_tokens: before, post_tokens: after, trigger } = event.compact_metadata || {};
      this.notice((trigger === 'auto' ? '上下文已自动压缩' : '上下文已压缩') + (before ? `（${before}${after ? ' → ' + after : ''} tokens）` : ''));
    }
    if (event.subtype === 'status' && event.status === 'compacting') this.message.activity = '正在压缩上下文';
    if (event.subtype === 'status' && event.compact_result === 'failed') this.notice('上下文压缩失败：' + (event.compact_error || '未知错误'), 'error');
    if (event.subtype === 'api_retry') this.message.activity = `API 请求失败（${event.error_status ?? event.error ?? '无响应'}），第 ${event.attempt}/${event.max_retries} 次重试`;
    if (event.subtype === 'notification' && event.priority !== 'low') this.notice(event.text);
    if (event.subtype === 'hook_response' && event.outcome === 'error') this.notice(`Hook ${event.hook_name} 失败：` + (event.stderr || event.output || ''), 'error');
  }

  consume(event) {
    if (event.parent_tool_use_id) { this.subagent(event); return; }
    if (event.type === 'stream_event') { delete this.message.activity; this.stream(event.event); }
    if (event.type === 'assistant') this.assistant(event);
    if (event.type === 'user') this.toolResults(event);
    if (event.type === 'system') this.system(event);
    if (event.type === 'tool_progress') {
      const block = this.message.blocks.find(item => item.id === event.tool_use_id);
      if (block?.status === 'running') block.elapsed = event.elapsed_time_seconds;
    }
    if (event.type === 'tool_use_summary') {
      const block = this.message.blocks.find(item => item.id === event.preceding_tool_use_ids?.at(-1));
      if (block) block.summary = event.summary;
    }
    if (event.type === 'auth_status' && event.error) this.notice('认证失败：' + event.error, 'error');
    if (event.type === 'conversation_reset') this.notice('Claude 的上下文已在此处重置，以上内容不再属于当前对话。', 'boundary');
    if (event.type === 'result') {
      if (event.is_error) this.message.error = event.result || event.errors?.join('\n') || '远端 Claude 返回错误';
      if (!this.message.blocks.some(b => b.type === 'text') && event.result && !event.is_error)
        this.addBlock({ type: 'text', text: event.result }, 'result');
      this.message.durationMs = event.duration_ms;
      this.message.costUSD = event.total_cost_usd;
      delete this.message.activity;
    }
  }
}
module.exports = { Transcript, newAssistant };

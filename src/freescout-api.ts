import type {
  CreateConversationParams,
  FreeScoutClickUpLink,
  FreeScoutConversation,
  FreeScoutApiResponse,
  FreeScoutRecipients,
  FreeScoutThread,
  SearchFilters,
  ListOrganisationsParams,
  OrgTicketSearchFilters,
} from './types.js';

interface RetryOptions {
  maxRetries?: number;
  initialDelay?: number;
  maxDelay?: number;
  timeout?: number;
}

export class FreeScoutAPI {
  private baseUrl: string;
  private apiKey: string;
  private retryOptions: Required<RetryOptions>;

  constructor(baseUrl: string, apiKey: string, retryOptions?: RetryOptions) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.apiKey = apiKey;
    this.retryOptions = {
      maxRetries: retryOptions?.maxRetries ?? 3,
      initialDelay: retryOptions?.initialDelay ?? 1000,
      maxDelay: retryOptions?.maxDelay ?? 10000,
      timeout: retryOptions?.timeout ?? 30000,
    };
  }

  /**
   * Parse relative time strings like "7d", "24h", "30m" to ISO date
   */
  private parseRelativeTime(relative: string): string | null {
    const match = relative.match(/^(\d+)([dhm])$/);
    if (!match) return null;

    const value = Number.parseInt(match[1], 10);
    if (!Number.isFinite(value) || value <= 0 || value > 10000) {
      return null;
    }
    const unit = match[2];
    const now = new Date();

    switch (unit) {
      case 'd':
        now.setDate(now.getDate() - value);
        break;
      case 'h':
        now.setHours(now.getHours() - value);
        break;
      case 'm':
        now.setMinutes(now.getMinutes() - value);
        break;
    }

    return now.toISOString();
  }

  /**
   * Exponential backoff retry logic with jitter
   */
  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async retryWithBackoff<T>(fn: () => Promise<T>, retryCount = 0): Promise<T> {
    try {
      return await fn();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const isRetryable =
        message.includes('ECONNRESET') ||
        message.includes('ETIMEDOUT') ||
        message.includes('429') ||
        message.includes('503') ||
        message.includes('502');

      if (!isRetryable || retryCount >= this.retryOptions.maxRetries) {
        throw error;
      }

      // Exponential backoff with jitter
      const delay = Math.min(
        this.retryOptions.initialDelay * Math.pow(2, retryCount) + Math.random() * 1000,
        this.retryOptions.maxDelay
      );

      console.error(
        `[FreeScout API] Retry ${retryCount + 1}/${this.retryOptions.maxRetries} after ${Math.round(delay)}ms. Error: ${message}`
      );

      await this.sleep(delay);
      return this.retryWithBackoff(fn, retryCount + 1);
    }
  }

  /**
   * Convert Markdown formatting to HTML for FreeScout
   */
  private markdownToHtml(text: string): string {
    // Step 1: Extract and protect fenced code blocks FIRST (before any other processing)
    // Use markers that won't be matched by bold/italic patterns and survive HTML escaping
    const fencedCodeBlocks: string[] = [];
    let processed = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _lang, code) => {
      const index = fencedCodeBlocks.length;
      const escapedCode = this.escapeHtml(code.trim());
      fencedCodeBlocks.push(`<pre><code>${escapedCode}</code></pre>`);
      return `[[[FENCED${index}]]]`;
    });

    // Step 2: Extract and protect inline code (before italic/bold conversion)
    const inlineCodeBlocks: string[] = [];
    processed = processed.replace(/`([^`]+)`/g, (_, code) => {
      const index = inlineCodeBlocks.length;
      const escapedCode = this.escapeHtml(code);
      inlineCodeBlocks.push(`<code>${escapedCode}</code>`);
      return `[[[INLINE${index}]]]`;
    });

    // Step 3: Now escape HTML and process formatting on remaining text
    const escaped = this.escapeHtml(processed);

    // Convert bold text: **text** or __text__ -> <strong>text</strong>
    let html = escaped
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/__(.*?)__/g, '<strong>$1</strong>');

    // Convert italic text: *text* or _text_ -> <em>text</em> (avoid conflicts with bold)
    html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
    html = html.replace(/(?<!_)_([^_]+)_(?!_)/g, '<em>$1</em>');

    // Process the entire text to handle lists that span paragraph breaks
    const lines = html.split('\n');
    const processedLines = [];
    let inOrderedList = false;
    let inUnorderedList = false;
    let currentParagraph = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();

      // Check for empty lines (paragraph breaks)
      if (!trimmedLine) {
        // Check if the next non-empty line is also a list item
        const nextListItemIndex = lines.slice(i + 1).findIndex((nextLine) => {
          const nextTrimmed = nextLine.trim();
          return nextTrimmed && (/^\d+\.\s+/.test(nextTrimmed) || /^[-*]\s+/.test(nextTrimmed));
        });

        // If we're in a list and the next item is also a list item, continue the list
        if ((inOrderedList || inUnorderedList) && nextListItemIndex !== -1) {
          continue; // Skip this empty line but keep the list open
        }

        // Close any current lists before starting new paragraph
        if (inOrderedList) {
          processedLines.push('</ol>');
          inOrderedList = false;
        }
        if (inUnorderedList) {
          processedLines.push('</ul>');
          inUnorderedList = false;
        }

        // Process accumulated paragraph
        if (currentParagraph.length > 0) {
          const paragraphContent = currentParagraph.join('<br>');
          processedLines.push(`<p>${paragraphContent}</p>`);
          currentParagraph = [];
        }

        // Skip extra empty lines
        continue;
      }

      // Check for numbered list items
      if (/^\d+\.\s+/.test(trimmedLine)) {
        // Finish any current paragraph
        if (currentParagraph.length > 0) {
          const paragraphContent = currentParagraph.join('<br>');
          processedLines.push(`<p>${paragraphContent}</p>`);
          currentParagraph = [];
        }

        if (!inOrderedList) {
          if (inUnorderedList) {
            processedLines.push('</ul>');
            inUnorderedList = false;
          }
          processedLines.push('<ol>');
          inOrderedList = true;
        }
        const content = trimmedLine.replace(/^\d+\.\s+/, '');
        processedLines.push(`<li>${content}</li>`);
      }
      // Check for bullet list items
      else if (/^[-*]\s+/.test(trimmedLine)) {
        // Finish any current paragraph
        if (currentParagraph.length > 0) {
          const paragraphContent = currentParagraph.join('<br>');
          processedLines.push(`<p>${paragraphContent}</p>`);
          currentParagraph = [];
        }

        if (!inUnorderedList) {
          if (inOrderedList) {
            processedLines.push('</ol>');
            inOrderedList = false;
          }
          processedLines.push('<ul>');
          inUnorderedList = true;
        }
        const content = trimmedLine.replace(/^[-*]\s+/, '');
        processedLines.push(`<li>${content}</li>`);
      }
      // Regular line
      else {
        // Close any lists
        if (inOrderedList) {
          processedLines.push('</ol>');
          inOrderedList = false;
        }
        if (inUnorderedList) {
          processedLines.push('</ul>');
          inUnorderedList = false;
        }

        // Add to current paragraph
        currentParagraph.push(trimmedLine);
      }
    }

    // Close any remaining lists
    if (inOrderedList) processedLines.push('</ol>');
    if (inUnorderedList) processedLines.push('</ul>');

    // Process any remaining paragraph
    if (currentParagraph.length > 0) {
      const paragraphContent = currentParagraph.join('<br>');
      processedLines.push(`<p>${paragraphContent}</p>`);
    }

    let result = processedLines.join('\n\n');

    // Step 4: Restore protected code blocks
    result = result.replace(/\[\[\[FENCED(\d+)]]]/g, (_, idx) => fencedCodeBlocks[parseInt(idx)]);
    result = result.replace(/\[\[\[INLINE(\d+)]]]/g, (_, idx) => inlineCodeBlocks[parseInt(idx)]);

    return result;
  }

  private escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private looksLikeHtml(text: string): boolean {
    // Heuristic: if it already contains common HTML tags, assume it's already formatted
    return /<\/?(p|br|div|span|strong|em|ul|ol|li|code|pre|blockquote|h[1-6])\b/i.test(text);
  }

  private containsMarkdownSyntax(text: string): boolean {
    return (
      text.includes('\n') ||
      /\*\*.+?\*\*/.test(text) ||
      /__.+?__/.test(text) ||
      /`[^`]+`/.test(text) ||
      /```[\s\S]*?```/.test(text) || // fenced code blocks
      /^\s*#{1,6}\s+.+/m.test(text) ||
      /^\s*[-*]\s+.+/m.test(text) ||
      /^\s*\d+\.\s+.+/m.test(text)
    );
  }

  private formatForFreeScoutEditor(text: string): string {
    if (this.looksLikeHtml(text)) return text;
    if (!this.containsMarkdownSyntax(text)) return this.escapeHtml(text);
    return this.markdownToHtml(text);
  }

  private async request<T>(path: string, method: string = 'GET', body?: unknown): Promise<T> {
    return this.retryWithBackoff(async () => {
      const url = `${this.baseUrl}/api${path}`;

      const headers: Record<string, string> = {
        'X-FreeScout-API-Key': this.apiKey,
      };

      if (body) {
        headers['Content-Type'] = 'application/json';
      }

      // Create abort controller for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.retryOptions.timeout);

      try {
        const response = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text();

          // Include status code in error for retry logic
          if (response.status === 429) {
            throw new Error(`FreeScout API rate limit (429): ${errorText}`);
          }
          if (response.status >= 500) {
            throw new Error(`FreeScout API server error (${response.status}): ${errorText}`);
          }

          throw new Error(`FreeScout API error: ${response.status} - ${errorText}`);
        }

        return response.json() as Promise<T>;
      } catch (error: unknown) {
        clearTimeout(timeoutId);

        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(`FreeScout API timeout after ${this.retryOptions.timeout}ms`);
        }

        throw error;
      }
    });
  }

  async getConversation(
    ticketId: string,
    includeThreads: boolean = true
  ): Promise<FreeScoutConversation> {
    const embed = includeThreads ? '?embed=threads' : '';
    return this.request<FreeScoutConversation>(`/conversations/${ticketId}${embed}`);
  }

  async addThread(
    ticketId: string,
    type: 'note' | 'message' | 'customer',
    text: string,
    userId?: number,
    state?: 'draft' | 'published',
    recipients?: FreeScoutRecipients
  ): Promise<FreeScoutThread> {
    const formattedText = this.formatForFreeScoutEditor(text);
    const body: {
      type: 'note' | 'message' | 'customer';
      text: string;
      user?: number;
      state?: 'draft' | 'published';
      to?: string[];
      cc?: string[];
      bcc?: string[];
    } = {
      type,
      text: formattedText,
    };

    if (userId) {
      body.user = userId;
    }

    if (state) {
      body.state = state;
    }

    if (recipients?.to !== undefined) {
      body.to = recipients.to;
    }

    if (recipients?.cc !== undefined) {
      body.cc = recipients.cc;
    }

    if (recipients?.bcc !== undefined) {
      body.bcc = recipients.bcc;
    }

    return this.request<FreeScoutThread>(`/conversations/${ticketId}/threads`, 'POST', body);
  }

  async createDraftReply(
    ticketId: string,
    text: string,
    userId: number,
    recipients?: FreeScoutRecipients
  ): Promise<FreeScoutThread> {
    return this.addThread(ticketId, 'message', text, userId, 'draft', recipients);
  }

  /**
   * Create a new conversation (ticket) with one thread.
   * POST /api/conversations needs `user` on message and note threads and
   * `customer` on customer threads, so this method fills in both.
   */
  async createConversation(
    params: CreateConversationParams
  ): Promise<FreeScoutConversation> {
    const threadType = params.threadType ?? 'customer';
    const customer = Object.fromEntries(
      Object.entries(params.customer).filter(([, value]) => value !== undefined)
    );

    const thread: Record<string, unknown> = {
      type: threadType,
      text: this.formatForFreeScoutEditor(params.text),
    };
    if (threadType === 'customer') {
      thread.customer = customer;
    } else if (params.userId) {
      thread.user = params.userId;
    }
    if (params.cc?.length) thread.cc = params.cc;
    if (params.bcc?.length) thread.bcc = params.bcc;

    const body: Record<string, unknown> = {
      type: params.conversationType ?? 'email',
      mailboxId: params.mailboxId,
      subject: params.subject,
      customer,
      threads: [thread],
    };
    if (params.assignTo) body.assignTo = params.assignTo;
    if (params.status) body.status = params.status;
    if (params.imported) body.imported = true;

    return this.request<FreeScoutConversation>('/conversations', 'POST', body);
  }

  /**
   * The web URL for a conversation, for linking people to a new ticket.
   */
  conversationUrl(conversationId: number | string): string {
    return `${this.baseUrl}/conversation/${conversationId}`;
  }

  async updateConversation(
    ticketId: string,
    updates: {
      status?: 'active' | 'pending' | 'closed' | 'spam';
      assignTo?: number;
      byUser?: number;
    }
  ): Promise<FreeScoutConversation> {
    return this.request<FreeScoutConversation>(`/conversations/${ticketId}`, 'PUT', updates);
  }

  /**
   * Search conversations with explicit filter parameters
   */
  async searchConversations(
    filters: SearchFilters
  ): Promise<FreeScoutApiResponse<FreeScoutConversation>> {
    const params = new URLSearchParams();

    // Text search
    if (filters.textSearch) {
      params.append('query', filters.textSearch.trim());
    }

    // Assignee filter
    if (filters.assignee !== undefined) {
      if (filters.assignee === 'unassigned') {
        params.append('assignee', 'null');
      } else if (filters.assignee === 'any') {
        // Don't add assignee filter
      } else {
        params.append('assignee', filters.assignee.toString());
      }
    }

    // Status filter
    if (filters.status) {
      if (filters.status === 'all') {
        params.append('status', 'active,pending,closed,spam');
      } else {
        params.append('status', filters.status);
      }
    }

    // State filter - default to 'published' when status is set to exclude deleted tickets
    if (filters.state) {
      params.append('state', filters.state);
    } else if (filters.status) {
      // When searching by status but no explicit state, exclude deleted tickets
      params.append('state', 'published');
    }

    // Mailbox filter
    if (filters.mailboxId != null) {
      params.append('mailboxId', filters.mailboxId.toString());
    }

    // Date filters - convert relative times to ISO dates
    if (filters.updatedSince) {
      const isoDate = this.parseRelativeTime(filters.updatedSince) || filters.updatedSince;
      params.append('updatedSince', isoDate);
    }

    if (filters.createdSince) {
      const isoDate = this.parseRelativeTime(filters.createdSince) || filters.createdSince;
      params.append('createdSince', isoDate);
    }

    // Pagination
    if (filters.page) {
      params.append('page', filters.page.toString());
    }

    if (filters.pageSize) {
      params.append('per_page', filters.pageSize.toString());
    }

    return this.request<FreeScoutApiResponse<FreeScoutConversation>>(
      `/conversations?${params.toString()}`
    );
  }

  /**
   * @deprecated Use searchConversations with SearchFilters instead
   */
  async searchConversationsLegacy(
    query: string,
    status?: string,
    state?: string,
    mailboxId?: number
  ): Promise<FreeScoutApiResponse<FreeScoutConversation>> {
    const statusValue = status;
    const stateValue = state;

    return this.searchConversations({
      textSearch: query,
      status:
        statusValue && ['active', 'pending', 'closed', 'spam', 'all'].includes(statusValue)
          ? (statusValue as SearchFilters['status'])
          : undefined,
      state:
        stateValue && ['published', 'deleted'].includes(stateValue)
          ? (stateValue as SearchFilters['state'])
          : undefined,
      mailboxId,
    });
  }

  async listConversations(
    status?: string,
    state?: string,
    assignee?: string | null
  ): Promise<FreeScoutApiResponse<FreeScoutConversation>> {
    const params = new URLSearchParams();
    if (status) params.append('status', status);
    if (state) params.append('state', state);
    if (assignee !== undefined) {
      if (assignee === null) {
        params.append('assignee', 'null');
      } else {
        params.append('assignee', assignee);
      }
    }

    return this.request<FreeScoutApiResponse<FreeScoutConversation>>(
      `/conversations?${params.toString()}`
    );
  }

  async getMailboxes(): Promise<unknown> {
    return this.request<unknown>('/mailboxes');
  }

  /**
   * Build query params for the organisation ticket-search / org-conversations endpoints.
   * Skips undefined/null/empty values; converts relative dates ("7d") on *Since/*Before fields.
   */
  private buildOrgTicketParams(filters: Record<string, unknown>): URLSearchParams {
    const params = new URLSearchParams();
    const dateFields = new Set([
      'createdSince',
      'createdBefore',
      'updatedSince',
      'updatedBefore',
      'waitingSince',
      'waitingBefore',
    ]);
    for (const [key, value] of Object.entries(filters)) {
      if (value === undefined || value === null || value === '') continue;
      if (dateFields.has(key) && typeof value === 'string') {
        params.append(key, this.parseRelativeTime(value) || value);
      } else {
        params.append(key, String(value));
      }
    }
    return params;
  }

  /**
   * List/search organisations (FreeScout ApiWebhooks organisation endpoints).
   */
  async listOrganisations(params: ListOrganisationsParams): Promise<unknown> {
    const qs = this.buildOrgTicketParams(params as Record<string, unknown>);
    return this.request<unknown>(`/organisations?${qs.toString()}`);
  }

  /**
   * Org-aware ticket search — the reliable per-client search.
   * Scope by organisationId or organisationDomain; returns the full matching history.
   */
  async ticketSearch(filters: OrgTicketSearchFilters): Promise<unknown> {
    const qs = this.buildOrgTicketParams(filters as Record<string, unknown>);
    return this.request<unknown>(`/ticket-search?${qs.toString()}`);
  }

  /**
   * List conversations for a specific organisation (org forced via the path).
   */
  async getOrganisationConversations(
    orgId: number,
    filters: Record<string, unknown> = {}
  ): Promise<unknown> {
    // org is in the path; drop any org keys from the query string
    const { organisationId: _oid, organisationDomain: _od, ...rest } = filters;
    void _oid;
    void _od;
    const qs = this.buildOrgTicketParams(rest);
    return this.request<unknown>(`/organisations/${orgId}/conversations?${qs.toString()}`);
  }

  /**
   * Link a ClickUp task to a conversation, as the ticket's ClickUp panel does
   * with "Link Existing". Needs the ClickUp module's API route on the server.
   * `task` is a ClickUp task ID or an https://app.clickup.com/t/<id> URL.
   */
  async linkClickUpTask(
    ticketId: string,
    task: string,
    userId?: number
  ): Promise<FreeScoutClickUpLink> {
    const body: { taskId: string; userId?: number } = { taskId: task };

    if (userId) {
      body.userId = userId;
    }

    return this.request<FreeScoutClickUpLink>(
      `/conversations/${ticketId}/clickup_tasks`,
      'POST',
      body
    );
  }

  extractTicketIdFromUrl(url: string): string | null {
    // Match patterns like:
    // https://domain.com/conversation/12345
    // https://domain.com/conversations/12345
    const match = url.match(/conversations?\/(\d+)/);
    return match ? match[1] : null;
  }

  parseTicketInput(input: string): string {
    // Check if input is a URL
    if (input.includes('http')) {
      const ticketId = this.extractTicketIdFromUrl(input);
      if (ticketId) return ticketId;
    }

    // Check if input is numeric (ticket ID)
    if (/^\d+$/.test(input.trim())) {
      return input.trim();
    }

    // Try to extract ticket ID from text like "ticket #12345"
    const match = input.match(/#?(\d+)/);
    if (match) {
      return match[1];
    }

    throw new Error(`Could not extract ticket ID from input: ${input}`);
  }
}

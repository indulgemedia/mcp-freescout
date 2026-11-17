#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRequire } from 'node:module';
import { z } from 'zod';
import {
  resolveDraftReplyRecipients,
  shouldInheritDraftRecipients,
} from './draft-recipients.js';
import { FreeScoutAPI } from './freescout-api.js';
import { TicketAnalyzer } from './ticket-analyzer.js';
import {
  TicketAnalysisSchema,
  SearchFiltersSchema,
  ListOrganisationsSchema,
  OrgTicketSearchSchema,
  OrgConversationsSchema,
  type FreeScoutRecipients,
} from './types.js';
import { loadEnv } from './env.js';

type PackageJson = { version: string };
const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as PackageJson;

// Load environment variables
loadEnv();

// Validate required environment variables
const FREESCOUT_URL = process.env.FREESCOUT_URL;
const FREESCOUT_API_KEY = process.env.FREESCOUT_API_KEY;
const DEFAULT_USER_ID = parseInt(process.env.FREESCOUT_DEFAULT_USER_ID || '1');

if (!FREESCOUT_URL || !FREESCOUT_API_KEY) {
  console.error('Missing required environment variables: FREESCOUT_URL and FREESCOUT_API_KEY');
  process.exit(1);
}

// Initialize API and analyzer
const api = new FreeScoutAPI(FREESCOUT_URL, FREESCOUT_API_KEY);
const analyzer = new TicketAnalyzer();

const allowedThreadTypes = new Set(['customer', 'message', 'note']);
type ThreadType = 'customer' | 'message' | 'note';

const isValidThreadType = (type: unknown): type is ThreadType =>
  typeof type === 'string' && allowedThreadTypes.has(type as ThreadType);

const hasCreatedAt = (createdAt: unknown): createdAt is string =>
  typeof createdAt === 'string' && createdAt.length > 0;

const normalizeThreadBody = (body: unknown) => (typeof body === 'string' ? body : '');

// Create MCP server with new McpServer class
const server = new McpServer({
  name: 'mcp-freescout',
  version: packageJson.version,
});

// Tool 1: Get Ticket
// Note: outputSchema removed due to MCP SDK JSON Schema conversion issues
// with undefined values. The raw API response may have missing fields.
server.registerTool(
  'freescout_get_ticket',
  {
    title: 'Get FreeScout Ticket',
    description:
      'Fetch and analyze a FreeScout ticket by ID or URL. The response includes the linked ClickUp task in "clickupTask" (id, url, name, listId) and every link in "clickupTasks"; both are absent or null when nothing is linked.',
    inputSchema: {
      ticket: z.string().describe('Ticket ID, ticket number, or FreeScout URL'),
      includeThreads: z
        .boolean()
        .optional()
        .default(true)
        .describe('Include all conversation threads'),
    },
  },
  async ({ ticket, includeThreads }) => {
    const ticketId = api.parseTicketInput(ticket);
    const conversation = await api.getConversation(ticketId, includeThreads ?? true);

    return {
      content: [{ type: 'text', text: JSON.stringify(conversation, null, 2) }],
    };
  }
);

// Tool 2: Analyze Ticket
server.registerTool(
  'freescout_analyze_ticket',
  {
    title: 'Analyze FreeScout Ticket',
    description:
      'Analyze a FreeScout ticket to determine issue type, root cause, and suggested solution. Reports the linked ClickUp task in "clickupTask" when the ticket has one.',
    inputSchema: {
      ticket: z.string().describe('Ticket ID, ticket number, or FreeScout URL'),
    },
    outputSchema: TicketAnalysisSchema,
  },
  async ({ ticket }) => {
    const ticketId = api.parseTicketInput(ticket);
    const conversation = await api.getConversation(ticketId, true);
    const analysis = analyzer.analyzeConversation(conversation);

    return {
      content: [{ type: 'text', text: JSON.stringify(analysis, null, 2) }],
      structuredContent: analysis,
    };
  }
);

// Tool 3: Add Note
server.registerTool(
  'freescout_add_note',
  {
    title: 'Add Note to Ticket',
    description: 'Add an internal note to a FreeScout ticket',
    inputSchema: {
      ticket: z.string().describe('Ticket ID, ticket number, or FreeScout URL'),
      note: z.string().describe('The note content to add'),
      userId: z.number().optional().describe('User ID for the note (default: from env)'),
    },
    outputSchema: {
      success: z.boolean(),
      message: z.string(),
      ticketId: z.string(),
    },
  },
  async ({ ticket, note, userId }) => {
    const ticketId = api.parseTicketInput(ticket);
    const actualUserId = userId ?? DEFAULT_USER_ID;

    await api.addThread(ticketId, 'note', note, actualUserId);

    const output = {
      success: true,
      message: `Note added to ticket #${ticketId}`,
      ticketId,
    };

    return {
      content: [{ type: 'text', text: output.message }],
      structuredContent: output,
    };
  }
);

// Tool 4: Update Ticket
server.registerTool(
  'freescout_update_ticket',
  {
    title: 'Update Ticket Status/Assignment',
    description: 'Update ticket status and/or assignment',
    inputSchema: {
      ticket: z.string().describe('Ticket ID, ticket number, or FreeScout URL'),
      status: z
        .enum(['active', 'pending', 'closed', 'spam'])
        .optional()
        .describe('New ticket status'),
      assignTo: z.number().optional().describe('User ID to assign the ticket to'),
    },
    outputSchema: {
      success: z.boolean(),
      message: z.string(),
      ticketId: z.string(),
    },
  },
  async ({ ticket, status, assignTo }) => {
    const ticketId = api.parseTicketInput(ticket);

    const updates: {
      status?: 'active' | 'pending' | 'closed' | 'spam';
      assignTo?: number;
      byUser?: number;
    } = { byUser: DEFAULT_USER_ID };
    if (status) updates.status = status;
    if (assignTo) updates.assignTo = assignTo;

    await api.updateConversation(ticketId, updates);

    const output = {
      success: true,
      message: `Ticket #${ticketId} updated successfully`,
      ticketId,
    };

    return {
      content: [{ type: 'text', text: output.message }],
      structuredContent: output,
    };
  }
);

// Tool 5: Create Draft Reply
server.registerTool(
  'freescout_create_draft_reply',
  {
    title: 'Create Draft Reply',
    description: 'Create a draft reply in FreeScout that can be edited before sending',
    inputSchema: {
      ticket: z.string().describe('Ticket ID, ticket number, or FreeScout URL'),
      replyText: z.string().describe('The draft reply content (generated by the LLM)'),
      userId: z
        .number()
        .optional()
        .describe('User ID creating the draft (defaults to env setting)'),
      to: z
        .array(z.string().email())
        .optional()
        .describe('Optional TO recipients. Omit to preserve existing recipients; pass [] to clear.'),
      cc: z
        .array(z.string().email())
        .optional()
        .describe('Optional CC recipients. Omit to preserve existing recipients; pass [] to clear.'),
      bcc: z
        .array(z.string().email())
        .optional()
        .describe('Optional BCC recipients. Omit to preserve existing recipients; pass [] to clear.'),
    },
    outputSchema: {
      success: z.boolean(),
      message: z.string(),
      ticketId: z.string(),
      draftId: z.number(),
    },
  },
  async ({ ticket, replyText, userId, to, cc, bcc }) => {
    const ticketId = api.parseTicketInput(ticket);
    const actualUserId = userId ?? DEFAULT_USER_ID;
    const requestedRecipients: FreeScoutRecipients = { to, cc, bcc };
    let recipientWarning: string | null = null;

    let inheritedRecipients: FreeScoutRecipients = {};
    if (shouldInheritDraftRecipients(requestedRecipients)) {
      try {
        const conversation = await api.getConversation(ticketId, false);
        inheritedRecipients = {
          to: conversation.to,
          cc: conversation.cc,
          bcc: conversation.bcc,
        };
      } catch {
        recipientWarning =
          'Unable to load existing recipients, so FreeScout default recipients were used for omitted fields.';
      }
    }

    const resolvedRecipients = resolveDraftReplyRecipients(
      requestedRecipients,
      inheritedRecipients
    );

    const draftThread = await api.createDraftReply(
      ticketId,
      replyText,
      actualUserId,
      resolvedRecipients
    );

    const output = {
      success: true,
      message: `Draft reply created successfully in FreeScout ticket #${ticketId}`,
      ticketId,
      draftId: draftThread.id,
    };

    return {
      content: [
        {
          type: 'text',
          text: `✅ ${output.message}\n\nDraft ID: ${draftThread.id}\n\nThe draft reply is now saved in FreeScout and can be reviewed, edited, and sent from the FreeScout interface.${recipientWarning ? `\n\nWarning: ${recipientWarning}` : ''}`,
        },
      ],
      structuredContent: output,
    };
  }
);

// Tool 6: Get Ticket Context
// Note: outputSchema removed - returns processed API data with optional fields
server.registerTool(
  'freescout_get_ticket_context',
  {
    title: 'Get Ticket Context',
    description: 'Get ticket context and customer info to help draft personalized replies',
    inputSchema: {
      ticket: z.string().describe('Ticket ID, ticket number, or FreeScout URL'),
    },
  },
  async ({ ticket }) => {
    const ticketId = api.parseTicketInput(ticket);
    const conversation = await api.getConversation(ticketId, true);
    const analysis = analyzer.analyzeConversation(conversation);

    const threads = conversation._embedded?.threads || [];
    const safeThreads = threads.filter((t) => isValidThreadType(t.type) && hasCreatedAt(t.created_at));
    const customerMessages = safeThreads.filter((t) => t.type === 'customer');
    const teamMessages = safeThreads.filter((t) => t.type === 'message' || t.type === 'note');

    const context = {
      ticketId,
      customer: {
        name: analysis.customerName,
        email: analysis.customerEmail,
      },
      subject: conversation.subject,
      status: conversation.status,
      clickupTask: conversation.clickupTask ?? null,
      issueDescription: analysis.issueDescription,
      customerMessages: customerMessages.map((m) => ({
        date: m.created_at,
        content: (() => {
          const body = normalizeThreadBody(m.body);
          const stripped = analyzer.stripHtml(body);
          return stripped.substring(0, 500) + (stripped.length > 500 ? '...' : '');
        })(),
      })),
      teamMessages: teamMessages.slice(-3).map((m) => ({
        date: m.created_at,
        content: (() => {
          const body = normalizeThreadBody(m.body);
          const stripped = analyzer.stripHtml(body);
          return stripped.substring(0, 300) + (stripped.length > 300 ? '...' : '');
        })(),
      })),
      analysis: {
        isBug: analysis.isBug,
        isThirdPartyIssue: analysis.isThirdPartyIssue,
        testedByTeam: analysis.testedByTeam,
        rootCause: analysis.rootCause,
      },
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(context, null, 2) }],
    };
  }
);

// Tool 7: Search Tickets
// Note: outputSchema removed - returns raw API search results with optional fields
server.registerTool(
  'freescout_search_tickets',
  {
    title: 'Search FreeScout Tickets',
    description:
      'Search for FreeScout tickets with explicit filter parameters. Use assignee: "unassigned" for unassigned tickets, or assignee: number for specific user. Supports relative time filters like "7d", "24h". Use includeLastMessage: true to get a preview of the most recent message for each ticket.',
    inputSchema: SearchFiltersSchema,
  },
  async (filters) => {
    const results = await api.searchConversations(filters);
    const conversations = results._embedded?.conversations || [];

    // If includeLastMessage is true, fetch threads for each conversation
    // and include a preview of the most recent message
    let conversationsWithPreview = conversations;
    if (filters.includeLastMessage && conversations.length > 0) {
      conversationsWithPreview = await Promise.all(
        conversations.map(async (conv) => {
          try {
            const fullConv = await api.getConversation(String(conv.id), true);
            const threads = fullConv._embedded?.threads || [];

            // Filter to actual messages (customer or message type, not notes)
            const messages = threads
              .filter((t) => t.type === 'customer' || t.type === 'message')
              .filter((t) => hasCreatedAt(t.created_at));

            // Sort by created_at descending and get the most recent
            const sortedMessages = messages.sort((a, b) => {
              const dateA = new Date(a.created_at || 0).getTime();
              const dateB = new Date(b.created_at || 0).getTime();
              return dateB - dateA;
            });

            const lastMessage = sortedMessages[0];
            if (lastMessage) {
              const body = normalizeThreadBody(lastMessage.body);
              const stripped = analyzer.stripHtml(body);
              const preview = stripped.substring(0, 300) + (stripped.length > 300 ? '...' : '');

              return {
                ...conv,
                lastMessage: {
                  type: lastMessage.type,
                  date: lastMessage.created_at,
                  preview,
                },
              };
            }
          } catch {
            // If fetching threads fails, just return the conversation without preview
          }
          return conv;
        })
      );
    }

    const output = {
      conversations: conversationsWithPreview,
      totalCount: results.page?.total_elements || 0,
      page: results.page?.number,
      totalPages: results.page?.total_pages,
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
    };
  }
);

// Tool 8: Get Mailboxes
// Note: outputSchema removed - returns raw API data
server.registerTool(
  'freescout_get_mailboxes',
  {
    title: 'Get Mailboxes',
    description: 'Get list of available mailboxes',
    inputSchema: {},
  },
  async () => {
    const mailboxes = await api.getMailboxes();

    return {
      content: [{ type: 'text', text: JSON.stringify(mailboxes, null, 2) }],
    };
  }
);

// Tool 9: List Organisations
server.registerTool(
  'freescout_list_organisations',
  {
    title: 'List FreeScout Organisations',
    description:
      'List or search FreeScout organisations (companies). Use this to resolve an organisation name or email domain to an organisation ID for org-scoped ticket search.',
    inputSchema: ListOrganisationsSchema,
  },
  async (params) => {
    const result = await api.listOrganisations(params);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool 10: Org-aware Ticket Search (the reliable per-client search)
server.registerTool(
  'freescout_ticket_search',
  {
    title: 'Org-aware Ticket Search',
    description:
      'Search FreeScout tickets scoped to an organisation — the reliable per-client search. Filter by organisationId or organisationDomain plus status/state/assignee/dates etc. Returns the full matching history (not just recent pages). Response is the standard {_embedded.conversations, page} shape; page.totalElements is the real count.',
    inputSchema: OrgTicketSearchSchema,
  },
  async (filters) => {
    const result = await api.ticketSearch(filters);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool 11: Organisation Conversations (org forced via path)
server.registerTool(
  'freescout_org_conversations',
  {
    title: 'Organisation Conversations',
    description:
      'List all conversations for a specific organisation ID (organisation is forced). Same filters as freescout_ticket_search.',
    inputSchema: OrgConversationsSchema,
  },
  async (filters) => {
    const { organisationId, ...rest } = filters;
    const result = await api.getOrganisationConversations(organisationId, rest);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool 12: Link a ClickUp task to a ticket
server.registerTool(
  'freescout_link_clickup_task',
  {
    title: 'Link ClickUp Task to Ticket',
    description:
      'Link an existing ClickUp task to a FreeScout ticket, the same as "Link Existing" in the ticket\'s ClickUp panel. The task then shows in the panel and in "clickupTasks" on freescout_get_ticket, and ClickUp gets a comment on the task with the ticket URL. Fails with 409 if the task is already linked to the ticket.',
    inputSchema: {
      ticket: z.string().describe('Ticket ID, ticket number, or FreeScout URL'),
      task: z
        .string()
        .describe(
          'ClickUp task ID (e.g. 869fk10yq) or task URL (https://app.clickup.com/t/869fk10yq)'
        ),
      userId: z
        .number()
        .optional()
        .describe('FreeScout user recorded as the linker (default: from env)'),
    },
  },
  async ({ ticket, task, userId }) => {
    const ticketId = api.parseTicketInput(ticket);
    const result = await api.linkClickUpTask(
      ticketId,
      task.trim(),
      userId ?? DEFAULT_USER_ID
    );

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
);

// Tool 13: Create a new ticket
server.registerTool(
  'freescout_create_ticket',
  {
    title: 'Create Ticket',
    description:
      'Create a new FreeScout ticket (conversation) with one first thread. threadType "customer" (default) logs the text as a message from the customer. "note" starts the ticket with an internal note. "message" sends the text to the customer as an email from the mailbox, so only use it when the user asked to email the customer. FreeScout finds the customer by email and creates them if they do not exist. Unless imported is true, FreeScout sends its usual notifications and mailbox auto-reply. Use freescout_get_mailboxes to find the mailboxId.',
    inputSchema: {
      mailboxId: z.number().describe('Mailbox ID (see freescout_get_mailboxes)'),
      subject: z.string().min(1).describe('Ticket subject'),
      text: z
        .string()
        .min(1)
        .describe('Body of the first thread (Markdown is converted to HTML)'),
      customerEmail: z
        .string()
        .email()
        .optional()
        .describe('Customer email. Give this or customerId.'),
      customerId: z
        .number()
        .optional()
        .describe('Existing FreeScout customer ID. Overrides customerEmail.'),
      customerFirstName: z
        .string()
        .optional()
        .describe('First name, used only when FreeScout creates a new customer'),
      customerLastName: z
        .string()
        .optional()
        .describe('Last name, used only when FreeScout creates a new customer'),
      threadType: z
        .enum(['customer', 'note', 'message'])
        .optional()
        .default('customer')
        .describe(
          'customer = from the customer (default); note = internal note; message = email to the customer (sends it)'
        ),
      conversationType: z
        .enum(['email', 'phone', 'chat'])
        .optional()
        .default('email')
        .describe('Conversation type (default email)'),
      userId: z
        .number()
        .optional()
        .describe('Author of a note or message thread (default: from env)'),
      assignTo: z.number().optional().describe('User ID to assign the ticket to'),
      status: z
        .enum(['active', 'pending', 'closed'])
        .optional()
        .describe('Initial status (FreeScout default: active)'),
      cc: z.array(z.string().email()).optional().describe('CC addresses for the thread'),
      bcc: z.array(z.string().email()).optional().describe('BCC addresses for the thread'),
      imported: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'true = no emails, notifications or auto-reply (for logging past conversations)'
        ),
    },
  },
  async params => {
    if (params.customerId === undefined && !params.customerEmail) {
      throw new Error('Give customerEmail or customerId');
    }

    const threadType = params.threadType ?? 'customer';
    const conversation = await api.createConversation({
      mailboxId: params.mailboxId,
      subject: params.subject,
      text: params.text,
      customer: {
        id: params.customerId,
        email: params.customerEmail,
        firstName: params.customerFirstName,
        lastName: params.customerLastName,
      },
      threadType,
      conversationType: params.conversationType ?? 'email',
      userId: threadType === 'customer' ? undefined : (params.userId ?? DEFAULT_USER_ID),
      assignTo: params.assignTo,
      status: params.status,
      cc: params.cc,
      bcc: params.bcc,
      imported: params.imported ?? false,
    });

    const output = {
      success: true,
      ticketId: conversation.id,
      number: conversation.number,
      subject: conversation.subject,
      status: conversation.status,
      url: api.conversationUrl(conversation.id),
    };

    return {
      content: [
        {
          type: 'text',
          text: `Created ticket #${output.number}: ${output.subject}\n${output.url}\n\n${JSON.stringify(output, null, 2)}`,
        },
      ],
    };
  }
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`FreeScout MCP Server v${packageJson.version} running...`);
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});

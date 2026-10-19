import { z } from 'zod';

// Zod Schemas for runtime validation
export const AttachmentSchema = z.object({
  id: z.number(),
  file_name: z.string(),
  mime_type: z.string(),
  size: z.number(),
  url: z.string().optional(),
});

export const ThreadSchema = z.object({
  id: z.number(),
  type: z.enum(['customer', 'message', 'note']).optional(),
  body: z.string().optional(),
  created_by_customer: z.boolean().optional(),
  created_at: z.string().optional(),
  to: z.array(z.string()).optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  attachments: z.array(AttachmentSchema).optional(),
});

export const CustomerSchema = z.object({
  id: z.number(),
  email: z.string().email(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  company: z.string().optional(),
  phone: z.string().optional(),
});

// A ClickUp task linked to a conversation, added to the FreeScout API response
// by the ClickUp module (Modules/ClickUp/Http/Middleware/InjectClickUpTasks.php).
export const ClickUpTaskSchema = z.object({
  id: z.string(),
  url: z.string().optional(),
  name: z.string().optional(),
  listId: z.string().optional(),
  linkedAt: z.string().nullable().optional(),
});

// Response from POST /api/conversations/{id}/clickup_tasks, the ClickUp module's
// link endpoint (Modules/ClickUp/Http/Controllers/Api/ClickUpApiController.php).
export const ClickUpLinkSchema = z.object({
  conversationId: z.number(),
  clickupTask: ClickUpTaskSchema,
  commentAdded: z.boolean(),
});

export const ConversationSchema = z.object({
  id: z.number(),
  number: z.number(),
  subject: z.string(),
  status: z.enum(['active', 'pending', 'closed', 'spam']),
  state: z.enum(['published', 'deleted']).optional(),
  user_id: z.number().nullable().optional(),
  customer_id: z.number().optional(),
  mailbox_id: z.number().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  to: z.array(z.string()).optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  clickupTask: ClickUpTaskSchema.nullable().optional(),
  clickupTasks: z.array(ClickUpTaskSchema).optional(),
  _embedded: z
    .object({
      threads: z.array(ThreadSchema).optional(),
      customer: CustomerSchema.optional(),
    })
    .optional(),
});

export const PageSchema = z.object({
  size: z.number(),
  total_elements: z.number(),
  total_pages: z.number(),
  number: z.number(),
});

export const ApiResponseSchema = z.object({
  _embedded: z
    .object({
      conversations: z.array(ConversationSchema).optional(),
      threads: z.array(ThreadSchema).optional(),
      customer: CustomerSchema.optional(),
    })
    .optional(),
  data: z.unknown().optional(),
  page: PageSchema.optional(),
});

export const TicketAnalysisSchema = z.object({
  ticketId: z.string(),
  customerName: z.string(),
  customerEmail: z.string().email(),
  issueDescription: z.string(),
  hasAttachments: z.boolean(),
  attachments: z.array(z.string()),
  codeSnippets: z.array(z.string()),
  errorMessages: z.array(z.string()),
  isReproducible: z.boolean(),
  testedByTeam: z.boolean(),
  suggestedSolution: z.string().optional(),
  isBug: z.boolean(),
  isThirdPartyIssue: z.boolean(),
  rootCause: z.string().optional(),
  clickupTask: ClickUpTaskSchema.nullable().optional(),
});

// Search filter schemas
export const SearchFiltersSchema = z.object({
  textSearch: z.string().optional(),
  assignee: z.union([z.literal('unassigned'), z.literal('any'), z.number()]).optional(),
  updatedSince: z.string().optional(), // ISO date or relative like "7d", "24h"
  createdSince: z.string().optional(),
  mailboxId: z.number().optional(),
  status: z.enum(['active', 'pending', 'closed', 'spam', 'all']).optional(),
  state: z.enum(['published', 'deleted']).optional(),
  page: z.number().min(1).optional(),
  pageSize: z.number().min(1).max(100).optional(),
  includeLastMessage: z.boolean().optional(), // Include the most recent message for each ticket
});

// Organisation API schemas (FreeScout ApiWebhooks organisation endpoints)
export const ListOrganisationsSchema = z.object({
  search: z.string().optional().describe('Search by organisation name or domain'),
  domain: z.string().optional().describe('Exact domain match, e.g. "thechateaubee.com"'),
  sortField: z.enum(['name', 'createdAt', 'customersCount']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  page: z.number().min(1).optional(),
  pageSize: z.number().min(1).max(200).optional(),
});

export const OrgTicketSearchSchema = z.object({
  organisationId: z
    .number()
    .optional()
    .describe('Organisation ID (resolve via freescout_list_organisations)'),
  organisationDomain: z.string().optional().describe('Organisation domain, e.g. "thechateaubee.com"'),
  status: z.string().optional().describe('CSV of active,pending,closed,spam'),
  state: z.string().optional().describe('published (default), all, or CSV of draft,published,deleted'),
  type: z.string().optional().describe('email, phone, or chat'),
  assignedTo: z.string().optional().describe('CSV of user IDs; "unassigned" or empty = no assignee'),
  mailboxId: z.string().optional().describe('CSV of mailbox IDs'),
  folderId: z.string().optional().describe('CSV of folder IDs'),
  customerId: z.number().optional(),
  customerEmail: z.string().optional(),
  number: z.string().optional().describe('Ticket number lookup'),
  subject: z.string().optional(),
  q: z.string().optional().describe('Free text over subject + preview'),
  createdSince: z.string().optional().describe('ISO-8601 UTC, or relative like "7d"/"24h"'),
  createdBefore: z.string().optional(),
  updatedSince: z.string().optional(),
  updatedBefore: z.string().optional(),
  waitingSince: z.string().optional(),
  waitingBefore: z.string().optional(),
  embed: z.string().optional().describe('CSV of threads,timelogs,tags'),
  sortField: z.enum(['createdAt', 'updatedAt', 'waitingSince', 'number', 'subject']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  page: z.number().min(1).optional(),
  pageSize: z.number().min(1).max(200).optional(),
});

export const OrgConversationsSchema = OrgTicketSearchSchema.extend({
  organisationId: z.number().describe('Organisation ID (required; org is forced)'),
});

export type ListOrganisationsParams = z.infer<typeof ListOrganisationsSchema>;
export type OrgTicketSearchFilters = z.infer<typeof OrgTicketSearchSchema>;
export type OrgConversationsParams = z.infer<typeof OrgConversationsSchema>;

// TypeScript types inferred from Zod schemas
export type FreeScoutAttachment = z.infer<typeof AttachmentSchema>;
export type FreeScoutThread = z.infer<typeof ThreadSchema>;
export type FreeScoutCustomer = z.infer<typeof CustomerSchema>;
export type FreeScoutConversation = z.infer<typeof ConversationSchema>;
export type FreeScoutClickUpTask = z.infer<typeof ClickUpTaskSchema>;
export type FreeScoutClickUpLink = z.infer<typeof ClickUpLinkSchema>;
export type FreeScoutApiResponse<T = unknown> = z.infer<typeof ApiResponseSchema> & { data?: T };
export type TicketAnalysis = z.infer<typeof TicketAnalysisSchema>;
export type SearchFilters = z.infer<typeof SearchFiltersSchema>;
export interface FreeScoutRecipients {
  to?: string[];
  cc?: string[];
  bcc?: string[];
}

// Legacy interfaces (deprecated, use Zod schemas above)
export interface FreeScoutPage {
  size: number;
  total_elements: number;
  total_pages: number;
  number: number;
}

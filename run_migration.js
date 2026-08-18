require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DIRECT_URL
    }
  }
});

const statements = [
`CREATE TABLE IF NOT EXISTS public.whatsapp_contacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  normalized_phone TEXT NOT NULL UNIQUE,
  relationship TEXT DEFAULT 'Contact',
  student_roll TEXT,
  student_name TEXT,
  student_class TEXT,
  is_verified BOOLEAN DEFAULT false,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);`,

`CREATE TABLE IF NOT EXISTS public.whatsapp_conversations (
  id TEXT PRIMARY KEY,
  contact_id TEXT REFERENCES public.whatsapp_contacts(id) ON DELETE SET NULL,
  phone TEXT NOT NULL,
  normalized_phone TEXT NOT NULL UNIQUE,
  contact_name TEXT NOT NULL,
  relationship TEXT DEFAULT 'Contact',
  student_roll TEXT,
  student_name TEXT,
  student_class TEXT,
  status TEXT DEFAULT 'open',
  priority TEXT DEFAULT 'normal',
  assigned_to TEXT,
  tags TEXT[] DEFAULT ARRAY[]::TEXT[],
  unread_count INT DEFAULT 0,
  last_message_text TEXT,
  last_message_at TIMESTAMPTZ DEFAULT now(),
  last_message_direction TEXT DEFAULT 'inbound',
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);`,

`CREATE TABLE IF NOT EXISTS public.whatsapp_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES public.whatsapp_conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  message_type TEXT DEFAULT 'text',
  content TEXT NOT NULL,
  media_url TEXT,
  media_filename TEXT,
  media_mime_type TEXT,
  media_size INT,
  is_internal_note BOOLEAN DEFAULT false,
  status TEXT DEFAULT 'sent' CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'read', 'failed')),
  provider_message_id TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT now(),
  read_at TIMESTAMPTZ
);`,

`CREATE TABLE IF NOT EXISTS public.whatsapp_attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT REFERENCES public.whatsapp_messages(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INT NOT NULL,
  storage_path TEXT NOT NULL,
  public_url TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);`
];

async function run() {
  try {
    for (const stmt of statements) {
      await prisma.$executeRawUnsafe(stmt);
    }
    console.log('✅ ALL WhatsApp tables CREATED SUCCESSFULLY in Supabase PostgreSQL!');
  } catch (e) {
    console.error('Migration error:', e.message);
  } finally {
    await prisma.$disconnect();
  }
}
run();

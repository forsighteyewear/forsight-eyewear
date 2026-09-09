import { createClient as createSupabaseClient } from '@supabase/supabase-js';

/**
 * Resolves the Supabase config to use for an upload/list/delete.
 * Priority: client-sent config → server environment variables.
 * This ensures operations work even when the frontend hasn't been
 * configured with the anon key (the server uses its own env vars).
 */
export function resolveSupabaseConfig(clientConfig) {
  const PLACEHOLDERS = ['your_supabase_anon_key', 'your-anon-key', 'placeholder', 'xxx', ''];
  const isPlaceholder = (v) => !v || PLACEHOLDERS.includes(String(v).trim().toLowerCase());
  const url = (clientConfig?.url && !isPlaceholder(clientConfig.url))
    ? clientConfig.url
    : (process.env.SUPABASE_URL && !isPlaceholder(process.env.SUPABASE_URL) ? process.env.SUPABASE_URL : '');
  const anonKey = (clientConfig?.anonKey && !isPlaceholder(clientConfig.anonKey))
    ? clientConfig.anonKey
    : (process.env.SUPABASE_ANON_KEY && !isPlaceholder(process.env.SUPABASE_ANON_KEY) ? process.env.SUPABASE_ANON_KEY : '');
  const bucket = clientConfig?.bucket || process.env.SUPABASE_BUCKET || 'videos';
  return { url, anonKey, bucket };
}

/**
 * Registers all customer-documents routes on an Express app:
 *   POST /api/customer-documents/upload  — upload a base64 file
 *   POST /api/customer-documents/list    — list docs for a client
 *   POST /api/customer-documents/delete  — delete a doc by path
 *
 * All routes resolve config from client-sent values first, then fall
 * back to server env vars (SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_BUCKET).
 */
export function registerCustomerDocUploadRoute(app) {
  // ---- Upload ----
  app.post('/api/customer-documents/upload', async (req, res) => {
    try {
      const { supabaseConfig: clientConfig, clientId, category, fileName, fileType, fileData } = req.body;
      if (!clientId || !fileName || !fileData) {
        return res.status(400).json({ message: 'clientId, fileName, and fileData are required' });
      }

      const supabaseConfig = resolveSupabaseConfig(clientConfig);
      if (!supabaseConfig.url || !supabaseConfig.anonKey || !supabaseConfig.bucket) {
        return res.status(400).json({
          message:
            'Supabase config required. Set SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_BUCKET as environment variables on this server (Render), or configure them in Admin → CRM & Settings → Storage.',
        });
      }

      const supabase = createSupabaseClient(supabaseConfig.url, supabaseConfig.anonKey);

      const safeName = (fileName || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
      const cat = category || 'General';
      const storageName = `${clientId}__${cat}__${Date.now()}_${safeName}`;
      const storagePath = `customer-docs/${storageName}`;

      // fileData is a data: URL — strip the prefix and decode base64
      const matches = /^data:([a-zA-Z0-9/.+-]+);base64,(.*)$/.exec(fileData);
      if (!matches) {
        return res.status(400).json({ message: 'fileData must be a base64 data URL' });
      }
      const contentType = fileType || matches[1] || 'application/octet-stream';
      const buffer = Buffer.from(matches[2], 'base64');

      const { error } = await supabase.storage
        .from(supabaseConfig.bucket)
        .upload(storagePath, buffer, {
          contentType,
          cacheControl: '3600',
          upsert: false,
        });

      if (error) throw error;

      const publicUrl = `${supabaseConfig.url}/storage/v1/object/public/${supabaseConfig.bucket}/${storagePath}`;
      res.json({
        success: true,
        storageName,
        fileName,
        fileType: contentType,
        url: publicUrl,
        path: storagePath,
      });
    } catch (error) {
      console.error('[customer-documents/upload] Error:', error.message);
      res.status(500).json({ message: error.message || 'Failed to upload document' });
    }
  });

  // ---- List ----
  app.post('/api/customer-documents/list', async (req, res) => {
    try {
      const { supabaseConfig: clientConfig, clientId } = req.body;
      const supabaseConfig = resolveSupabaseConfig(clientConfig);
      if (!supabaseConfig.url || !supabaseConfig.anonKey || !supabaseConfig.bucket) {
        return res.status(400).json({
          message:
            'Supabase config required. Set SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_BUCKET as environment variables on this server (Render), or configure them in Admin → CRM & Settings → Storage.',
        });
      }
      const supabase = createSupabaseClient(supabaseConfig.url, supabaseConfig.anonKey);
      const { data: files, error } = await supabase.storage
        .from(supabaseConfig.bucket)
        .list('customer-docs', { limit: 500, sortBy: { column: 'created_at', order: 'desc' } });

      if (error) throw error;

      const docs = (files || [])
        .filter((f) => (clientId ? f.name.startsWith(clientId + '__') : true))
        .map((f) => {
          const parts = f.name.split('__');
          return {
            id: f.id || f.name,
            fileName: parts.slice(2).join('__') || f.name,
            fileType: f.metadata?.mimetype || 'application/octet-stream',
            fileSize: f.metadata?.size || 0,
            uploadedAt: f.created_at || new Date().toISOString(),
            category: parts[1] || 'General',
            url: `${supabaseConfig.url}/storage/v1/object/public/${supabaseConfig.bucket}/customer-docs/${encodeURIComponent(f.name)}`,
            path: `customer-docs/${f.name}`,
          };
        });

      res.json({ success: true, documents: docs });
    } catch (error) {
      res.status(500).json({ message: error.message || 'Failed to list documents' });
    }
  });

  // ---- Delete ----
  app.post('/api/customer-documents/delete', async (req, res) => {
    try {
      const { supabaseConfig: clientConfig, path } = req.body;
      if (!path) {
        return res.status(400).json({ message: 'File path required' });
      }
      const supabaseConfig = resolveSupabaseConfig(clientConfig);
      if (!supabaseConfig.url || !supabaseConfig.anonKey || !supabaseConfig.bucket) {
        return res.status(400).json({ message: 'Supabase config required' });
      }
      const supabase = createSupabaseClient(supabaseConfig.url, supabaseConfig.anonKey);
      const { error } = await supabase.storage.from(supabaseConfig.bucket).remove([path]);
      if (error) throw error;
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ message: error.message || 'Failed to delete document' });
    }
  });
}

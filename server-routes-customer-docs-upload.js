import { createClient as createSupabaseClient } from '@supabase/supabase-js';

/**
 * Registers the /api/customer-documents/upload endpoint on an Express app.
 * Uploads a file (sent as a base64 data URL) to Supabase storage.
 *
 * Body: { supabaseConfig, clientId, category, fileName, fileType, fileData }
 */
export function registerCustomerDocUploadRoute(app) {
  app.post('/api/customer-documents/upload', async (req, res) => {
    try {
      const { supabaseConfig, clientId, category, fileName, fileType, fileData } = req.body;
      if (!supabaseConfig?.url || !supabaseConfig?.anonKey || !supabaseConfig?.bucket) {
        return res.status(400).json({ message: 'Supabase config required' });
      }
      if (!clientId || !fileName || !fileData) {
        return res.status(400).json({ message: 'clientId, fileName, and fileData are required' });
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
}

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { FileServiceError, safeFile } from './files.js';

const statements = [
  'Compare the supplier invoice with the purchase order.',
  'Flag any difference in quantities, prices, or totals.',
  'Make a short review summary showing the amount and any issues.',
  'Ask me to approve matching invoices before adding them to the payment list.',
];
const filenames = ['invoice.pdf', 'purchase-order.pdf'];

/** Examples are ordinary documents, uploaded through the same receipt boundary as user files. */
export function registerWorkflowExampleRoutes(app: FastifyInstance, sampleDir = path.resolve('catalog/simple-invoice')) {
  async function document(name: string) {
    if (!filenames.includes(name)) throw new FileServiceError(404, 'EXAMPLE_NOT_FOUND', 'This sample document was not found.');
    const file = await safeFile(sampleDir, name);
    try {
      if (file.size > 1024 * 1024) throw new FileServiceError(500, 'INVALID_EXAMPLE', 'The sample document is too large.');
      return await file.handle.readFile();
    } finally { await file.handle.close(); }
  }

  app.get('/api/workflow-examples', async () => [{
    id: 'invoice-check', name: 'Invoice check',
    description: 'Check an invoice against its purchase order before approving payment. Try it with two realistic sample documents.',
    statements,
    files: await Promise.all(filenames.map(async name => ({ name, mime: 'application/pdf', size: (await document(name)).length, downloadUrl: `/api/workflow-examples/invoice-check/documents/${name}` }))),
  }]);

  app.get<{ Params: { name: string } }>('/api/workflow-examples/invoice-check/documents/:name', async (request, reply) => {
    const name = request.params.name;
    const bytes = await document(name);
    return reply.header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'no-store')
      .header('Content-Disposition', `attachment; filename="${name}"`).type('application/pdf').send(bytes);
  });

  app.post('/api/workflow-examples/invoice-check/files', async (_request, reply) => {
    const boundary = `example-${randomUUID()}`;
    const chunks: Buffer[] = [];
    for (const name of filenames) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n`));
      chunks.push(await document(name), Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    const response = await app.inject({ method: 'POST', url: '/api/files/upload', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(chunks) });
    return reply.code(response.statusCode).send(response.json());
  });
}

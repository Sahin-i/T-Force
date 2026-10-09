/** Retain the process lock until Fastify has awaited every teardown hook. */
export async function closeApplication(app:{close():Promise<void>}|undefined,release:()=>Promise<void>):Promise<void> {
  try {await app?.close();}finally{await release();}
}

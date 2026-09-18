// Only a current, browser-verified mapping can be recommended or executed.
export function normalizeModels(models) {
  const unique = new Map();
  for (const model of Array.isArray(models) ? models : []) {
    if (!model || typeof model.id !== 'string' || !model.id.trim() || typeof model.name !== 'string') continue;
    const verification = ['discovered','learning','verified','stale','unsupported'].includes(model.verification) ? model.verification : 'discovered';
    unique.set(model.id, { id: model.id, name: model.name,
      description: typeof model.description === 'string' ? model.description : '',
      thinking: model.thinking === true, verification,
      mapping_revision: typeof model.mapping_revision === 'string' ? model.mapping_revision : null });
  }
  return [...unique.values()].sort((a,b) => {
    if (a.thinking !== b.thinking) return Number(b.thinking)-Number(a.thinking);
    const version = m => (m.id.match(/\d+(?:\.\d+)*/)?.[0] || '0').split('.').map(Number);
    const av=version(a), bv=version(b);
    for(let i=0;i<Math.max(av.length,bv.length);i++) {
      const diff=(bv[i]||0)-(av[i]||0); if(diff) return diff;
    }
    return a.id.localeCompare(b.id);
  });
}
export function recommendedModel(models) {
  const verified=normalizeModels(models).filter(m=>m.verification==='verified' && m.mapping_revision);
  return (verified.find(m=>m.thinking) || verified.find(m=>m.id==='gemini-3.8-flash') || verified.find(m=>/flash/i.test(m.id)) || verified[0])?.id ?? null;
}

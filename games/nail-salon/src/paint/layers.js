// @ts-check
// Pure (no DOM, no three.js): what each nail of a Design (PLAN §9.3) is made of.

/**
 * What one nail of a Design looks like, resolved against the catalog. Pure (no three.js), so it
 * is unit tested. Art that is objects, not polish (stickers, gems, dots, glitter jar, stamps) is
 * returned in `objects` for the nail record; it is not drawn yet (those tools come in M3).
 * @param {any} design §9.3 Design
 * @param {number} finger 0 thumb … 4 pinky
 * @param {any} catalog data/catalog.json
 * @returns {{ base: any, over: any, mode: 'solid' | 'french' | 'ombre', topCoat: string | null, objects: any[] }}
 */
export function nailLayers(design, finger, catalog) {
  const find = (id) => {
    if (id == null) return null;
    const p = catalog.polishes.find((q) => q.id === id);
    if (!p) throw new Error(`unknown polish: ${id}`);
    return { ...p, finishData: catalog.finishes[p.finish] };
  };
  const accent = design.accent && design.accent.finger === finger;
  const base = find(accent ? design.accent.polish : design.polish);
  const art = design.art || [];
  const tip = accent ? null : art.find((a) => a.kind === 'french' || a.kind === 'ombre');
  if (art.filter((a) => a.kind === 'french' || a.kind === 'ombre').length > 1) throw new Error('a design has one french or ombre, not both');
  const over = tip ? find(tip.polish) : null;
  return {
    base, over,
    mode: over ? tip.kind : 'solid',
    topCoat: design.topCoat ?? null,
    objects: art.filter((a) => a.kind !== 'french' && a.kind !== 'ombre'),
  };
}

/**
 * Extract unique work item IDs from a checkin comment. Recognises both
 * "#1234" and "WI:1234" forms. Duplicates are dropped so ADO doesn't
 * reject the checkin on repeat links.
 */
export function parseWorkItemIds(comment: string): number[] {
    const seen = new Set<number>();
    const ids: number[] = [];
    for (const m of comment.matchAll(/#(\d+)|WI:(\d+)/gi)) {
        const id = parseInt(m[1] || m[2], 10);
        if (!seen.has(id)) {
            seen.add(id);
            ids.push(id);
        }
    }
    return ids;
}

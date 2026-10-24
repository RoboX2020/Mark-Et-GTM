# Anchor interviews

Real interviews (for example, exported from Listen Labs) that anchor the
synthetic population. Put one or more JSON files here. Each file holds an
object or an array of objects:

```json
{
  "id": "ll_2026_07_14_03",
  "segmentHint": "graduate student, budget-conscious, heavy Notion user",
  "summary": "Plans weekly on Sunday; abandoned two planners because setup took too long. Would pay if it imported from Canvas.",
  "quotes": ["If it can't read my syllabus I'm not typing it all in again."],
  "statedWtp": 6
}
```

Keep only a summary and short quotes. Don't store names, emails or other
identifiers. The engine matches each anchor to the closest graph segment. That
anchor then shifts the segment's willingness to pay and appears in persona
bios as an outlook, never as an identity.

If this folder has no JSON files, labelled fixture anchors are used and the
report says so.

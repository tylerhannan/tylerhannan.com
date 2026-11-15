-- One post elsewhere: aiGenerate summarizes the post itself ({src}), as a scripts/ch UPDATE.
WITH
    (s -> concat('''', replaceAll(replaceAll(s, '\\', '\\\\'), '''', '\\'''), '''')) AS lit,
    (SELECT any(w) FROM url({base:String} || '/writing.json', RawBLOB)
     ARRAY JOIN JSONExtractArrayRaw(raw_blob, 'writing') AS w WHERE JSONExtractString(w, 'url') = {url:String}) AS row
SELECT 'UPDATE writing SET ai_summary = ' || lit(trimBoth(aiGenerate(
           'Title: ' || JSONExtractString(row, 'title') || '\nPublished on ' || JSONExtractString(row, 'venue') || ', '
           || JSONExtractString(row, 'date') || '\n\nPage text:\n' || substring(extractTextFromHTML(raw_blob), 1, 20000),
           map('system_prompt', 'You write the one- or two-sentence summary that sits under a link to a blog post, to help site search find it. Lead with the subject itself, not the author: no ''I'', ''we'', ''the author'', ''this post'' or ''the post''. Name the specific things the post covers: products, versions, people, companies, techniques, and the main point or result. Plain, conversational English, contractions are fine, a little dry. Use only what the post says. The page text includes site navigation, footers and archive banners: ignore them. No praise, no hype words, no em dashes, no exclamation marks, no colon-led setups like ''The takeaway:'', no preamble. 25 to 40 words.',
               'temperature', '0.2', 'max_tokens', '4000'))))
       || ' WHERE url = ' || lit({url:String}) || ';'
FROM url({src:String}, RawBLOB)
FORMAT TSVRaw

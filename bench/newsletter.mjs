// The benchmark's email: a newsletter as email builders write it (a centred 600px table of nested tables,
// legacy attributes, a <style> block with class rules, inline styles on cells), of `blocks` blocks of 30
// elements. The default, 67 blocks, is 2,005 elements in the tree mail.parse builds, and about 101 kB of HTML.
export function newsletterHtml(blocks = 67, offset = 0) {
  const cell = (i) => `<td class="cell${i % 2 ? ' alt' : ''}" width="33%" valign="top" style="padding:8px;border-bottom:1px solid #dddddd">`
    + `<p class="item">Item <span class="n">${i}</span> <a href="https://example.com/item/${i}?utm_source=news&amp;m=1">more</a></p></td>`;
  const block = (b) => `<tr><td style="padding:16px 0"><table class="grid" width="100%" cellpadding="0" cellspacing="0" border="0">`
    + [0, 1].map((r) => `<tr>${[0, 1, 2].map((c) => cell(offset + b * 6 + r * 3 + c)).join('')}</tr>`).join('\n')
    + `</table></td></tr>\n`;
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Weekly digest</title>
<style type="text/css">
  body { margin: 0; padding: 0; background-color: #eeeeee; }
  table, td { border-collapse: collapse; mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
  .wrapper { width: 600px; margin: 0 auto; background-color: #ffffff; }
  .grid { table-layout: fixed; border-spacing: 0; }
  .cell { background-color: #ffffff; }
  .cell.alt { background-color: #fafafa; }
  .item { margin: 0 0 4px; font-size: 14px; line-height: 20px; color: #333333; font-family: Arial, sans-serif; }
  .n { font-weight: bold; color: #003366; }
  .item a { color: #0066cc; text-decoration: underline; }
  a:hover { color: red; }
  @media only screen and (max-width: 480px) { .wrapper { width: 100% !important; } .cell { display: block !important; width: 100% !important; } }
</style>
</head>
<body style="margin:0;padding:0" bgcolor="#eeeeee">
<table class="wrapper" align="center" cellpadding="0" cellspacing="0" border="0">
${Array.from({ length: blocks }, (_, b) => block(b)).join('')}</table>
</body>
</html>
`;
}

import re, sys
from xml.etree import ElementTree as ET

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
tree = ET.parse('C:/Users/Z/AppData/Local/Temp/srsx/word/document.xml')
root = tree.getroot()
body = root.find(W+'body')

def para_text(p):
    parts = []
    for node in p.iter():
        if node.tag == W+'t':
            parts.append(node.text or '')
        elif node.tag == W+'tab':
            parts.append('\t')
        elif node.tag == W+'br':
            parts.append(' ')
    return ''.join(parts)

def para_style(p):
    pPr = p.find(W+'pPr')
    if pPr is None: return None, None
    st = pPr.find(W+'pStyle')
    style = st.get(W+'val') if st is not None else None
    numPr = pPr.find(W+'numPr')
    ilvl = None
    if numPr is not None:
        il = numPr.find(W+'ilvl')
        ilvl = il.get(W+'val') if il is not None else '0'
    return style, ilvl

out = []
def walk(container, depth=0):
    for child in container:
        if child.tag == W+'p':
            style, ilvl = para_style(child)
            txt = para_text(child).strip()
            if not txt:
                continue
            if style and style.startswith('Heading'):
                lvl = style.replace('Heading','')
                try: n = int(lvl)
                except: n = 1
                out.append('\n' + '#'*min(n,6) + ' ' + txt)
            elif style == 'Title':
                out.append('\n# ' + txt)
            elif ilvl is not None:
                out.append('  '*int(ilvl) + '- ' + txt)
            else:
                out.append(txt)
        elif child.tag == W+'tbl':
            out.append('\n[TABLE]')
            for tr in child.findall(W+'tr'):
                cells = []
                for tc in tr.findall(W+'tc'):
                    ctext = ' '.join(para_text(p).strip() for p in tc.findall(W+'p'))
                    cells.append(ctext.strip())
                out.append('| ' + ' | '.join(cells) + ' |')
            out.append('[/TABLE]\n')
        elif child.tag == W+'sdt':
            c = child.find(W+'sdtContent')
            if c is not None: walk(c, depth+1)

walk(body)
text = '\n'.join(out)
text = re.sub(r'\n{3,}', '\n\n', text)
open('C:/Users/Z/AppData/Local/Temp/srs.md','w',encoding='utf-8').write(text)
print(len(text), 'chars', text.count('\n'), 'lines')

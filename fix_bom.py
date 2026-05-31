import codecs

path = "config.json"

# 自动去掉 BOM
with codecs.open(path, "r", "utf-8-sig") as f:
    content = f.read()

# 写回纯 UTF-8（无 BOM）
with open(path, "w", encoding="utf-8") as f:
    f.write(content)

print("🎉 config.json 已成功转换为纯 UTF-8（无 BOM）")

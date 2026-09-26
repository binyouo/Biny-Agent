# 交给 verifier 的环境变量。格式是 harbor 要的 KEY=VALUE（每行一个，不是 shell export）。
# 用法：run-tb21.sh 会把每一行转成 --verifier-env KEY=VALUE。
#
# x86_64 setup 会预置 uv/uvx、pytest 和独立 CPython，默认禁止 uv 再下载 Python。
# FastVerifier 运行时若找不到预置 pytest（例如 ARM64），会保留 task 原始安装流程，
# 并把 UV_PYTHON_DOWNLOADS 临时改为 auto，允许原本要求的 uvx 获取指定解释器。
PATH=/root/.local/bin:/opt/biny-verifier-python/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
LD_LIBRARY_PATH=/opt/biny-verifier-python/lib
UV_PYTHON_DOWNLOADS=never

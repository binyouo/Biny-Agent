# 交给 verifier 的环境变量。格式是 harbor 要的 KEY=VALUE（每行一个，不是 shell export）。
# 用法：run-tb21.sh 会把每一行转成 --verifier-env KEY=VALUE。
#
# 判分依赖（uv/uvx、pytest、独立 CPython）已经在 setup 阶段铺进容器了，
# 这里只是把路径交给 verifier。UV_PYTHON_DOWNLOADS=never 特别关键：少了它，
# uvx 会在判分阶段联网下载 Python —— 又押在那条会抖的容器网络上，
# 于是「模型做对了、判分器起不来、记 0 分」。
PATH=/root/.local/bin:/opt/biny-verifier-python/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
LD_LIBRARY_PATH=/opt/biny-verifier-python/lib
UV_PYTHON_DOWNLOADS=never

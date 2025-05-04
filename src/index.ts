import { Context, Schema, h } from 'koishi'
import { ImageStorage } from './imageStorage'
import path from 'path'

export const name = 'archive'

export interface Config {}

export const Config: Schema<Config> = Schema.object({})

export async function apply(ctx: Context) {
  // 创建图片存储管理器实例
  const imageStorage = new ImageStorage('./data/archive', ctx.logger('archive'))
  await imageStorage.init()

  // 检查会话有效性
  function validateSession(session) {
    return session?.channelId || null
  }

  // 创建主命令 - 改为随机展示同一批次的图片
  const cmd = ctx.command('archive', '从史册中随机展示珍藏图片')
    .option('batch', '-b 仅显示批次ID而不展示图片', { value: false })
    .action(async ({ session, options }) => {
      const channelId = validateSession(session)
      if (!channelId) return '无法确认所在之地，请于明确场所使用此令。'

      try {
        // 获取随机批次ID
        const randomBatch = await imageStorage.getRandomBatchId(channelId)

        if (!randomBatch) {
          return '本史册尚无珍藏，请先上传图片以供后世瞻仰。'
        }

        // 如果只需展示批次ID，直接返回
        if (options.batch) {
          return `随机抽取史册批次: ${randomBatch}`
        }

        // 获取该批次的所有图片
        const batchImages = await imageStorage.findBatchImages(channelId, randomBatch)

        if (batchImages.length === 0) {
          return '史册查询异常，此批次无法展示。'
        }

        // 获取图片路径
        const channelPath = await imageStorage.getChannelPath(channelId)
        const imagePaths = batchImages.map(file =>
          path.resolve(path.join(channelPath, file))
        )

        // 构建展示消息
        const images = imagePaths.map(path => h.image(`file://${path}`))
        return h('message', [
          `史册随机展示批次 ${randomBatch} 的珍藏(共 ${images.length} 幅):`,
          ...images
        ])
      } catch (error) {
        ctx.logger.error(`展示图片时出错: ${error}`)
        return '展示图片时发生意外，详情已录入史官日志。'
      }
    })

  // 上传子命令 - 将同一消息中的图片视为一组
  cmd.subcommand('.upload', '将图片珍藏入史册')
    .alias('.upd')
    .option('name', '-n <name:string> 赐予图片专属名讳')
    .action(async ({ session, options }) => {
      const channelId = validateSession(session)
      if (!channelId) return '无法确认所在之地，请于明确场所使用此令。'

      // 处理会话中的图片
      const imageUrls = extractImageUrls(session)

      if (imageUrls.length === 0) {
        return '未觅得任何图片，请附上欲珍藏之图。'
      }

      // 生成批次ID
      const batchId = imageStorage.generateBatchId()
      const customName = options.name || '珍藏'

      let savedCount = 0
      const results = []
      const savedFiles = []

      for (let i = 0; i < imageUrls.length; i++) {
        const imageUrl = imageUrls[i]
        // 使用批次ID_序号_名称_时间戳格式
        const index = i+1
        const timestamp = imageStorage.generateTimestamp()
        const finalName = `${batchId}_${index}_${customName}_${timestamp}`

        const result = await imageStorage.downloadAndSaveImage(ctx, imageUrl, channelId, finalName)

        if (result.success) {
          results.push(`✓ 史册新增: ${result.fileName}`)
          savedFiles.push(result.fileName)
          savedCount++
        } else {
          results.push(`✗ 珍藏失败: ${result.error?.message || '原因未明'}`)
        }
      }

      const message = `珍藏完成，共录入 ${savedCount}/${imageUrls.length} 张图片。\n批次ID: ${batchId}\n${results.join('\n')}`

      return message
    })

  // 删除子命令
  cmd.subcommand('.delete [fileName:string]', '从史册中抹去指定图片')
    .alias('.del')
    .action(async ({ session }, fileName) => {
      const channelId = validateSession(session)
      if (!channelId) return '无法确认所在之地，请于明确场所使用此令。'

      if (!fileName) {
        return '请指明欲抹去之图片名讳。'
      }

      try {
        const matchedFiles = await imageStorage.findMatchingImages(channelId, fileName)

        if (matchedFiles.length === 0) {
          return `史册中未寻得名为 "${fileName}" 的图片。`
        }

        if (matchedFiles.length > 1) {
          return `查得多幅相似图片: ${matchedFiles.join(', ')}\n请提供更明确的名讳。`
        }

        const fileToDelete = matchedFiles[0]
        const success = await imageStorage.deleteImage(channelId, fileToDelete)

        return success ? `已将 ${fileToDelete} 从史册中抹去` : '抹去失败，详情已录入史官日志。'
      } catch (error) {
        ctx.logger.error(`删除图片时出错: ${error}`)
        return '抹去图片时发生意外，详情已录入史官日志。'
      }
    })

  // 添加批次查看命令
  cmd.subcommand('.group <batchId:string>', '查看指定批次的图片')
    .alias('.batch')
    .action(async ({ session }, batchId) => {
      const channelId = validateSession(session)
      if (!channelId) return '无法确认所在之地，请于明确场所使用此令。'

      if (!batchId) {
        return '请提供批次编号。'
      }

      try {
        const matchedFiles = await imageStorage.findBatchImages(channelId, batchId)

        if (matchedFiles.length === 0) {
          return `史册中未寻得批次 "${batchId}" 的图片。`
        }

        // 获取图片全路径
        const channelPath = await imageStorage.getChannelPath(channelId)
        const imagePaths = matchedFiles.map(file =>
          path.resolve(path.join(channelPath, file))
        )

        // 构建展示消息
        const images = imagePaths.map(path => h.image(`file://${path}`))
        return h('message', [`史册中批次 ${batchId} 共有 ${images.length} 幅珍藏:`, ...images])
      } catch (error) {
        ctx.logger.error(`查询批次图片时出错: ${error}`)
        return '查阅批次时发生意外，详情已录入史官日志。'
      }
    })

  // 搜索子命令 - 支持展示搜索结果图片
  cmd.subcommand('.search <keyword:string>', '在史册中查找图片')
    .alias('.find')
    .option('show', '-s 展示搜索到的图片', { value: false })
    .action(async ({ session, options }, keyword) => {
      const channelId = validateSession(session)
      if (!channelId) return '无法确认所在之地，请于明确场所使用此令。'

      if (!keyword) {
        return '请提供查询关键词。'
      }

      try {
        const matchedFiles = await imageStorage.findMatchingImages(channelId, keyword)

        if (matchedFiles.length === 0) {
          return `史册中未寻得与 "${keyword}" 相关的图片。`
        }

        // 仅展示文件列表
        if (!options.show) {
          return `史册查得 ${matchedFiles.length} 幅相关图片:\n${matchedFiles.join('\n')}`
        }

        // 展示找到的图片(最多5张)
        const limit = Math.min(5, matchedFiles.length)
        const channelPath = await imageStorage.getChannelPath(channelId)
        const imagePaths = matchedFiles.slice(0, limit).map(file =>
          path.resolve(path.join(channelPath, file)))

        const images = imagePaths.map(path => h.image(`file://${path}`))
        const suffix = matchedFiles.length > limit ? `\n(仅展示前${limit}张)` : ''

        return h('message', [`史册查得 ${matchedFiles.length} 幅相关图片${suffix}:`, ...images])
      } catch (error) {
        ctx.logger.error(`搜索图片时出错: ${error}`)
        return '查阅史册时发生意外，详情已录入史官日志。'
      }
    })

  // 提取会话中的图片URL - 精简版
  function extractImageUrls(session): string[] {
    const urls = new Set()

    // 处理elements中的图片
    if (session.elements) {
      session.elements.forEach(element => {
        if (element.type === 'img' && element.attrs?.src) {
          urls.add(decodeHTMLEntities(element.attrs.src))
        }
      })
    }

    // 处理文本内容中的图片标签
    if (session.content) {
      // 统一正则匹配所有图片标签格式
      const patterns = [
        { regex: /<image url="([^"]+)"[^>]*>/g, group: 1, prefix: 'url=' },
        { regex: /<img[^>]+src="([^"]+)"/g, group: 1, prefix: 'src=' },
        { regex: /<ing>([^<]+)<\/ing>/g, group: 1, prefix: 'ing=' }
      ]

      patterns.forEach(pattern => {
        const matches = session.content.match(pattern.regex) || []
        matches.forEach(match => {
          const valueMatch = match.match(new RegExp(`${pattern.prefix.replace('=', '=')}\"?([^\"]+)\"?`))
          if (valueMatch?.[1]) {
            urls.add(decodeHTMLEntities(valueMatch[1]))
          }
        })
      })
    }

    return Array.from(urls) as string[]
  }

  // HTML实体解码函数 - 精简版
  function decodeHTMLEntities(text: string): string {
    return text.replace(/&amp;/g, '&')
       .replace(/&lt;/g, '<')
       .replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"')
       .replace(/&#0?39;/g, "'")
       .replace(/&apos;/g, "'");
  }
}

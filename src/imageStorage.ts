import fs from 'fs/promises'
import path from 'path'
import { Context, Logger } from 'koishi'
import { randomBytes } from 'crypto'

export class ImageStorage {
  private basePath: string
  private logger: Logger

  constructor(basePath: string = './data/archive', logger: Logger) {
    this.basePath = basePath
    this.logger = logger
  }

  // 初始化存储目录
  async init(): Promise<void> {
    try {
      await fs.mkdir(this.basePath, { recursive: true })
    } catch (error) {
      this.logger.error(`无法创建史册根目录: ${error}`)
    }
  }

  // 获取并确保频道目录存在
  async getChannelPath(channelId: string): Promise<string> {
    const channelPath = path.join(this.basePath, channelId)
    try {
      await fs.mkdir(channelPath, { recursive: true })
    } catch (error) {
      this.logger.error(`无法创建频道史册: ${error}`)
    }
    return channelPath
  }

  // 下载并保存图片 - 精简版
  async downloadAndSaveImage(ctx: Context, url: string, channelId: string, customFileName?: string): Promise<{ success: boolean, fileName?: string, error?: any }> {
    try {
      // 解码并清理URL
      url = this.decodeHTMLEntities(url.replace(/<[^>]*>/g, '').trim())

      // 验证URL
      let validUrl: URL
      try {
        validUrl = new URL(url)
      } catch (error) {
        throw new Error(`图片链接无效: ${url}`)
      }

      // 下载图片
      let buffer: ArrayBuffer
      try {
        buffer = await ctx.http.get(url, {
          responseType: 'arraybuffer',
          timeout: 30000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          }
        })

        if (!buffer || buffer.byteLength === 0) {
          throw new Error('图片内容为空')
        }
      } catch (err) {
        throw new Error(`下载失败: ${err.message || err}`)
      }

      // 确定扩展名和文件名
      let ext = this.getExtensionFromUrl(validUrl) || 'jpg'

      // 生成文件名
      let fileName: string = customFileName
        ? (customFileName.includes('.') ? customFileName : `${customFileName}.${ext}`)
        : `${this.generateTimestamp()}.${ext}`;

      // 确保文件名安全
      fileName = fileName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');

      // 保存文件
      const channelPath = await this.getChannelPath(channelId)
      const filePath = path.join(channelPath, fileName)

      await fs.writeFile(filePath, Buffer.from(buffer))
      return { success: true, fileName }

    } catch (error) {
      this.logger.error(`珍藏图片失败: ${error}`)
      return { success: false, error }
    }
  }

  // 从URL获取文件扩展名
  private getExtensionFromUrl(url: URL): string | null {
    if (url.pathname) {
      const ext = path.extname(url.pathname).toLowerCase()
      if (ext && ext !== '.') {
        return ext.substring(1)
      }
    }
    return null
  }

  // 生成批次ID - 用于标识同一消息上传的图片
  public generateBatchId(): string {
    // 生成6位随机字母数字ID
    return randomBytes(3).toString('hex').substring(0, 6).toUpperCase()
  }

  // 生成时间戳文件名
  public generateTimestamp(): string {
    return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').split('Z')[0]
  }

  // HTML实体解码
  private decodeHTMLEntities(text: string): string {
    return text.replace(/&amp;/g, '&')
       .replace(/&lt;/g, '<')
       .replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"')
       .replace(/&#0?39;/g, "'")
       .replace(/&apos;/g, "'")
       .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec))
       .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }

  // 获取图片列表
  async getImageList(channelId: string): Promise<string[]> {
    try {
      const channelPath = await this.getChannelPath(channelId)
      const files = await fs.readdir(channelPath)
      return files.filter(file => path.extname(file).toLowerCase() !== '')
    } catch (error) {
      this.logger.error(`查阅史册失败: ${error}`)
      return []
    }
  }

  // 获取随机多张图片
  async getRandomImages(channelId: string, count: number = 1): Promise<string[]> {
    const imageFiles = await this.getImageList(channelId)

    if (imageFiles.length === 0) return []

    // 如果请求数量大于可用图片总数，返回所有图片（随机顺序）
    count = Math.min(count, imageFiles.length)

    // 随机选择图片
    const result: string[] = []
    const channelPath = await this.getChannelPath(channelId)

    // 打乱图片数组
    const shuffled = [...imageFiles].sort(() => 0.5 - Math.random())

    // 取前count张
    for (let i = 0; i < count; i++) {
      result.push(path.resolve(path.join(channelPath, shuffled[i])))
    }

    return result
  }

  // 保持单图片获取方法的兼容性
  async getRandomImage(channelId: string): Promise<string | null> {
    const images = await this.getRandomImages(channelId, 1)
    return images.length > 0 ? images[0] : null
  }

  // 删除图片
  async deleteImage(channelId: string, fileName: string): Promise<boolean> {
    try {
      const channelPath = await this.getChannelPath(channelId)
      await fs.unlink(path.join(channelPath, fileName))
      return true
    } catch (error) {
      this.logger.error(`抹去图片失败: ${error}`)
      return false
    }
  }

  // 查找匹配的图片 - 增强功能
  async findMatchingImages(channelId: string, pattern: string): Promise<string[]> {
    const imageFiles = await this.getImageList(channelId)
    // 按文件名创建日期倒序排列 (新的在前)
    return imageFiles
      .filter(file => file.includes(pattern))
      .sort((a, b) => {
        // 尝试从文件名中提取时间戳
        const timeA = this.extractTimestampFromFilename(a)
        const timeB = this.extractTimestampFromFilename(b)
        // 如果无法提取时间戳，则按字母顺序倒序排列
        return (timeB || b).localeCompare(timeA || a)
      })
  }

  // 按批次ID查找图片
  async findBatchImages(channelId: string, batchId: string): Promise<string[]> {
    const imageFiles = await this.getImageList(channelId)
    // 查找文件名以batchId开头的图片
    const batchFiles = imageFiles.filter(file => file.startsWith(`${batchId}_`))

    // 按序号排序(从1开始)
    return batchFiles.sort((a, b) => {
      // 提取序号部分
      const numA = this.extractSequenceNumber(a, batchId)
      const numB = this.extractSequenceNumber(b, batchId)
      return numA - numB
    })
  }

  // 从文件名提取序号
  private extractSequenceNumber(filename: string, batchId: string): number {
    // 文件名格式为: batchId_序号_名称_时间戳
    // 去掉batchId_前缀后，序号是第一部分
    const withoutPrefix = filename.substring(batchId.length + 1)
    const parts = withoutPrefix.split('_')
    if (parts.length >= 1) {
      const num = parseInt(parts[0], 10)
      return isNaN(num) ? 999999 : num // 无效序号排到最后
    }
    return 999999 // 默认大值
  }

  // 从文件名中提取时间戳
  private extractTimestampFromFilename(filename: string): string | null {
    // 尝试匹配ISO日期格式
    const match = filename.match(/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/)
    return match ? match[0] : null
  }

  // 获取随机批次ID
  async getRandomBatchId(channelId: string): Promise<string | null> {
    try {
      const imageFiles = await this.getImageList(channelId)

      if (imageFiles.length === 0) {
        return null
      }

      // 提取所有图片文件的批次ID
      const batchIds = new Set<string>()
      for (const file of imageFiles) {
        // 批次ID是文件名的第一部分(以_分隔)
        const parts = file.split('_')
        if (parts.length >= 2) {
          // 检查第一部分是否符合6位字符的批次ID格式
          const potentialBatchId = parts[0]
          if (/^[0-9A-F]{6}$/.test(potentialBatchId)) {
            batchIds.add(potentialBatchId)
          }
        }
      }

      // 没有有效的批次ID
      if (batchIds.size === 0) {
        // 回退方案：随机选择一个文件
        const randomFile = imageFiles[Math.floor(Math.random() * imageFiles.length)]
        return randomFile
      }

      // 从批次ID集合中随机选择一个
      const batchIdArray = Array.from(batchIds)
      const randomIndex = Math.floor(Math.random() * batchIdArray.length)
      return batchIdArray[randomIndex]
    } catch (error) {
      this.logger.error(`获取随机批次ID失败: ${error}`)
      return null
    }
  }
}

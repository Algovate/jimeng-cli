import fs from "fs";
import _ from "lodash";

import Request from "@/lib/request/Request.ts";
import { generateImages, generateImageComposition } from "@/api/controllers/images.ts";
import { DEFAULT_IMAGE_MODEL } from "@/api/consts/common.ts";
import { pickTokenForModelRequest } from "@/api/routes/token-selector.ts";
import {
  assertNoUnsupportedParams,
  isMultipartRequest,
  parseOptionalBoolean,
  parseOptionalNumber
} from "@/api/routes/route-helpers.ts";
import util from "@/lib/util.ts";

export default {
  prefix: "/v1/images",

  post: {
    "/generations": async (request: Request) => {
      assertNoUnsupportedParams(
        request.body,
        ["size", "width", "height"],
        (params) => `不支持的参数: ${params.join(", ")}。请使用 ratio 和 resolution 参数控制图像尺寸。`
      );

      request
        .validate("body.model", v => _.isUndefined(v) || _.isString(v))
        .validate("body.prompt", _.isString)
        .validate("body.negative_prompt", v => _.isUndefined(v) || _.isString(v))
        .validate("body.ratio", v => _.isUndefined(v) || _.isString(v))
        .validate("body.resolution", v => _.isUndefined(v) || _.isString(v))
        .validate("body.intelligent_ratio", v => _.isUndefined(v) || _.isBoolean(v))
        .validate("body.sample_strength", v => _.isUndefined(v) || _.isFinite(v))
        .validate("body.response_format", v => _.isUndefined(v) || _.isString(v))
        .validate("body.wait", v => _.isUndefined(v) || _.isBoolean(v))
        .validate("body.wait_timeout_seconds", v => _.isUndefined(v) || _.isFinite(v))
        .validate("body.poll_interval_ms", v => _.isUndefined(v) || _.isFinite(v));

      const {
        model,
        prompt,
        negative_prompt: negativePrompt,
        ratio,
        resolution,
        intelligent_ratio: intelligentRatio,
        sample_strength: sampleStrength,
        response_format,
        wait,
        wait_timeout_seconds: waitTimeoutSeconds,
        poll_interval_ms: pollIntervalMs,
      } = request.body;
      const finalModel = _.defaultTo(model, DEFAULT_IMAGE_MODEL);
      const tokenCtx = pickTokenForModelRequest(request, {
        requestedModel: finalModel,
        taskType: "image",
      });

      const responseFormat = _.defaultTo(response_format, "url");
      const imageResult = await generateImages(finalModel, prompt, {
        ratio,
        resolution,
        sampleStrength,
        negativePrompt,
        intelligentRatio,
        wait,
        waitTimeoutSeconds,
        pollIntervalMs,
      }, tokenCtx.token, tokenCtx.regionInfo);

      if (!Array.isArray(imageResult)) {
        return imageResult;
      }

      const imageUrls = imageResult;
      let data = [];
      if (responseFormat == "b64_json") {
        data = (
          await Promise.all(imageUrls.map((url) => util.fetchFileBASE64(url)))
        ).map((b64) => ({ b64_json: b64 }));
      } else {
        data = imageUrls.map((url) => ({
          url,
        }));
      }
      return {
        created: util.unixTimestamp(),
        data,
      };
    },
    
    "/compositions": async (request: Request) => {
      assertNoUnsupportedParams(
        request.body,
        ["size", "width", "height"],
        (params) => `不支持的参数: ${params.join(", ")}。请使用 ratio 和 resolution 参数控制图像尺寸。`
      );

      const isMultiPart = isMultipartRequest(request.headers["content-type"]);

      if (isMultiPart) {
        request
          .validate("body.model", v => _.isUndefined(v) || _.isString(v))
          .validate("body.prompt", _.isString)
          .validate("body.negative_prompt", v => _.isUndefined(v) || _.isString(v))
          .validate("body.ratio", v => _.isUndefined(v) || _.isString(v))
          .validate("body.resolution", v => _.isUndefined(v) || _.isString(v))
          .validate("body.intelligent_ratio", v => _.isUndefined(v) || (typeof v === 'string' && (v === 'true' || v === 'false')) || _.isBoolean(v))
          .validate("body.sample_strength", v => _.isUndefined(v) || (typeof v === 'string' && !isNaN(parseFloat(v))) || _.isFinite(v))
          .validate("body.response_format", v => _.isUndefined(v) || _.isString(v))
          .validate("body.wait", v => _.isUndefined(v) || (typeof v === 'string' && (v === 'true' || v === 'false')) || _.isBoolean(v))
          .validate("body.wait_timeout_seconds", v => _.isUndefined(v) || (typeof v === 'string' && !isNaN(parseFloat(v))) || _.isFinite(v))
          .validate("body.poll_interval_ms", v => _.isUndefined(v) || (typeof v === 'string' && !isNaN(parseFloat(v))) || _.isFinite(v));
      } else {
        request
          .validate("body.model", v => _.isUndefined(v) || _.isString(v))
          .validate("body.prompt", _.isString)
          .validate("body.images", _.isArray)
          .validate("body.negative_prompt", v => _.isUndefined(v) || _.isString(v))
          .validate("body.ratio", v => _.isUndefined(v) || _.isString(v))
          .validate("body.resolution", v => _.isUndefined(v) || _.isString(v))
          .validate("body.intelligent_ratio", v => _.isUndefined(v) || _.isBoolean(v))
          .validate("body.sample_strength", v => _.isUndefined(v) || _.isFinite(v))
          .validate("body.response_format", v => _.isUndefined(v) || _.isString(v))
          .validate("body.wait", v => _.isUndefined(v) || _.isBoolean(v))
          .validate("body.wait_timeout_seconds", v => _.isUndefined(v) || _.isFinite(v))
          .validate("body.poll_interval_ms", v => _.isUndefined(v) || _.isFinite(v));
      }

      let images: (string | Buffer)[] = [];
      if (isMultiPart) {
        const files = request.files?.images;
        if (!files) {
          throw new Error("在form-data中缺少 'images' 字段");
        }
        const imageFiles = Array.isArray(files) ? files : [files];
        if (imageFiles.length === 0) {
          throw new Error("至少需要提供1张输入图片");
        }
        if (imageFiles.length > 10) {
          throw new Error("最多支持10张输入图片");
        }
        images = imageFiles.map(file => fs.readFileSync(file.filepath));
      } else {
        const bodyImages = request.body.images;
        if (!bodyImages || bodyImages.length === 0) {
          throw new Error("至少需要提供1张输入图片");
        }
        if (bodyImages.length > 10) {
          throw new Error("最多支持10张输入图片");
        }
        bodyImages.forEach((image: any, index: number) => {
          if (!_.isString(image) && !_.isObject(image)) {
            throw new Error(`图片 ${index + 1} 格式不正确：应为URL字符串或包含url字段的对象`);
          }
          if (_.isObject(image) && !(image as { url?: string }).url) {
            throw new Error(`图片 ${index + 1} 缺少url字段`);
          }
        });
        images = bodyImages.map((image: any) => _.isString(image) ? image : image.url);
      }

      const {
        model,
        prompt,
        negative_prompt: negativePrompt,
        ratio,
        resolution,
        intelligent_ratio: intelligentRatio,
        sample_strength: sampleStrength,
        response_format,
        wait,
        wait_timeout_seconds: waitTimeoutSeconds,
        poll_interval_ms: pollIntervalMs,
      } = request.body;
      const finalModel = _.defaultTo(model, DEFAULT_IMAGE_MODEL);
      const tokenCtx = pickTokenForModelRequest(request, {
        requestedModel: finalModel,
        taskType: "image",
      });

      // 如果是 multipart/form-data，需要将字符串转换为数字和布尔值
      const finalSampleStrength = isMultiPart
        ? parseOptionalNumber(sampleStrength)
        : sampleStrength;

      const finalIntelligentRatio = isMultiPart
        ? parseOptionalBoolean(intelligentRatio)
        : intelligentRatio;
      const finalWait = isMultiPart
        ? parseOptionalBoolean(wait)
        : wait;
      const finalWaitTimeoutSeconds = isMultiPart
        ? parseOptionalNumber(waitTimeoutSeconds)
        : waitTimeoutSeconds;
      const finalPollIntervalMs = isMultiPart
        ? parseOptionalNumber(pollIntervalMs)
        : pollIntervalMs;

      const responseFormat = _.defaultTo(response_format, "url");
      const compositionResult = await generateImageComposition(finalModel, prompt, images, {
        ratio,
        resolution,
        sampleStrength: finalSampleStrength,
        negativePrompt,
        intelligentRatio: finalIntelligentRatio,
        wait: finalWait,
        waitTimeoutSeconds: finalWaitTimeoutSeconds,
        pollIntervalMs: finalPollIntervalMs,
      }, tokenCtx.token, tokenCtx.regionInfo);

      if (!Array.isArray(compositionResult)) {
        return compositionResult;
      }

      const resultUrls = compositionResult;

      let data = [];
      if (responseFormat == "b64_json") {
        data = (
          await Promise.all(resultUrls.map((url) => util.fetchFileBASE64(url)))
        ).map((b64) => ({ b64_json: b64 }));
      } else {
        data = resultUrls.map((url) => ({
          url,
        }));
      }

      return {
        created: util.unixTimestamp(),
        data,
        input_images: images.length,
        composition_type: "multi_image_synthesis",
      };
    },
  },
};

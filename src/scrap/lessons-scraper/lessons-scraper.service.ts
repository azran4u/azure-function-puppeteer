import { Inject, Injectable } from "@nestjs/common";
import { WINSTON_MODULE_PROVIDER } from "nest-winston";
import { Logger } from "winston";
import { Page } from "puppeteer";
import { BrowserService } from "../browser/browser.service";
import * as _ from "lodash";
import { Lesson } from "../../model/lesson";
import { ConfigService } from "@nestjs/config";
import { NotificationsService } from "../../telegram/notifications/notifications.service";
import { ObjectStorageService } from "../../object-storage/object-storage/object-storage.service";
import { RabbiEnum } from "../../model/rabi.enum";
import { Snapshot } from "../../model/snapshot";

@Injectable()
export class LessonsScraperService {
  private retries: number;
  private url: string;
  constructor(
    @Inject(WINSTON_MODULE_PROVIDER) private logger: Logger,
    private configService: ConfigService,
    private browserService: BrowserService,
    private objectStorgaeService: ObjectStorageService,
    private telegramService: NotificationsService
  ) {
    this.logger.info(`LessonsScraperService constructor`);
    this.url = this.configService.get("scrap.rabbiUrl", { infer: true });
    this.retries = this.configService.get("scrap.retries", { infer: true });
  }

  public async scrapController() {
    try {
      const rabbi = RabbiEnum.RABBI_FIREMAN;
      await this.telegramService.sendMessage("start scraping");
      const lessons: Lesson[] = await (
        await this.objectStorgaeService.getRabbiLastSnapshot(rabbi)
      ).lessons;
      await this.logAndTelegram(
        `read ${lessons.length} lessons of rabbi ${rabbi} from object storage`
      );
      const pageUrls = await this.rabbiPagination(this.url);
      for (let page of pageUrls) {
        const lessonsUrls = await this.extractLessonsUrlsFromRabbiPage(page);
        for (let lessonUrl of lessonsUrls) {
          if (lessons.find((x) => x.url === lessonUrl)) {
            this.logger.debug(`${lessonUrl} already exists`);
            continue;
          }
          const lesson = await this.lessonScarpper(lessonUrl);
          if (!lesson.valid) {
            this.logger.info(`${lessonUrl} is invalid`);
          }
          lessons.push(lesson);
          this.logger.info(`${page} ${lesson.id} saved`);
        }
      }
      const snapshot: Snapshot = {
        rabbi,
        date: new Date(),
        lessons,
      };
      await this.objectStorgaeService.storeSnapshot(snapshot);
      await this.logAndTelegram(
        `total of ${snapshot.lessons.length} lessons for rabbi ${snapshot.rabbi} saved to object storage`
      );
      const browser = await this.browserService.getBrowser();
      await browser.close();
    } catch (error) {
      await this.logAndTelegram(`error in scrapController ${error}`, "error");
    }
  }

  private async logAndTelegram(message: string, level?: string) {
    if (level === "error") {
      this.logger.error(message);
    } else {
      this.logger.info(message);
    }
    await this.telegramService.sendMessage(message);
  }
  public async genericScrapper<T>(
    url: string,
    f: (x: Page) => Promise<T>
  ): Promise<T> {
    const retries: number = this.retries;
    for (let i = 1; 1 <= retries; i++) {
      try {
        this.logger.info(`open url ${url}`);
        const browser = await this.browserService.getBrowser();
        let page = await browser.newPage();
        await page.setExtraHTTPHeaders({
          "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/95.0.4638.69 Safari/537.36",
        });
        await page.setRequestInterception(true);
        const block_ressources = [
          "image",
          "stylesheet",
          "media",
          "font",
          "texttrack",
          "object",
          "beacon",
          "csp_report",
          "imageset",
          "xhr",
          "other",
          "ping",
        ];
        page.on("request", (request) => {
          const resource = request.resourceType().trim().toLowerCase();
          try {
            if (block_ressources.includes(resource)) {
              this.logger.debug(`skip ${resource}`);
              request.abort();
            } else {
              this.logger.debug(`download resource ${resource}`);
              request.continue();
            }
          } catch (error) {
            this.logger.error(
              `error handling resource ${resource} in url ${url} ${error}`
            );
          }
        });
        await page.goto(url);
        const res = await f(page);
        await page.close();
        return res;
      } catch (error) {
        this.logger.error(`cannot scrap ${url} ${error}`);
      }
    }
  }

  public async extractLessonsUrlsFromRabbiPage(url: string) {
    return this.genericScrapper(url, async (page) => {
      await page.waitForSelector(".jet-listing-grid__items[data-nav]");
      const res = await page.$$("div[data-post-id]");
      res.map((r) => r);
      let urls = await page.$$eval("div[data-post-id]", (links) =>
        links.map((link) => link.querySelector("a[href]").getAttribute("href"))
      );
      return urls;
    });
  }

  public async rabbiPagination(url: string) {
    return this.genericScrapper(url, async (page) => {
      await page.waitForSelector("a.facetwp-page.last"); //.jet-listing-grid__items[data-nav]
      const lastPageNumber = await page.$eval(
        "a.facetwp-page.last",
        (elm) => +elm["textContent"]
      );
      const pagesUrls: string[] = [];
      for (let i = 1; i <= lastPageNumber; i++) {
        pagesUrls.push(`${url}&_paged=${i}`);
      }
      return pagesUrls;
    });
  }

  private convertDate(date: string): Date | undefined {
    const [hebrewMonth, stringDay, stringYear] = date
      .substring(date.indexOf(`(`) + 1, date.indexOf(`)`))
      .replace(`,`, "")
      .split(" ");
    const month = this.convertMonthToNumber(hebrewMonth);
    const day = +stringDay;
    const year = +stringYear;
    let res: Date;
    try {
      res = new Date(year, month, day, 0, 0, 0, 0);
      return res;
    } catch (error) {
      this.logger.error(`could not parse date ${date}`);
      return undefined;
    }
  }

  private convertMonthToNumber(month: string) {
    const convertMonth = new Map<string, number>();
    convertMonth.set("??????????", 0);
    convertMonth.set("????????????", 1);
    convertMonth.set("??????", 2);
    convertMonth.set("??????????", 3);
    convertMonth.set("??????", 4);
    convertMonth.set("????????", 5);
    convertMonth.set("????????", 6);
    convertMonth.set("????????????", 7);
    convertMonth.set("????????????", 8);
    convertMonth.set("??????????????", 9);
    convertMonth.set("????????????", 10);
    convertMonth.set("??????????", 11);
    const res = convertMonth.get(month);
    if (!res) return -1;
    return res;
  }

  public async lessonScarpper(url: string): Promise<Lesson | undefined> {
    return this.genericScrapper(url, async (page) => {
      await page.waitForSelector(".jet-listing-grid__items[data-nav]");

      let mp3Url: string;
      let title: string;
      let tags: string[] = [];
      let keywords: string[];
      let series: string[];
      let lessonUrl: string;
      let date: Date;
      let id: string;

      try {
        mp3Url = await page.$eval('a[href$="mp3"]', (elm) => elm["href"]);
      } catch (error) {
        console.error(`url ${url} has no mp3 file`);
        mp3Url = undefined;
      }

      try {
        title = await page.$eval(
          "h1.elementor-heading-title.elementor-size-default",
          (elm) => elm["textContent"]
        );
      } catch (error) {
        console.error(`url ${url} has no title`);
        title = undefined;
      }

      try {
        keywords = await page.$eval(`a[href*="shiurim-tags"`, (elm) =>
          elm["textContent"].split(",").map((x) => x.trim())
        );
        tags = tags.concat(keywords);
      } catch (error) {}

      try {
        series = await page.$eval(`a[href*="shiurim-series"`, (elm) =>
          elm["textContent"].split(",").map((x) => x.trim())
        );
        tags = tags.concat(series);
      } catch (error) {}

      try {
        const stringDate = await page.$eval(
          `span.elementor-icon-list-text.elementor-post-info__item`,
          (elm) => elm["textContent"]
        );
        date = this.convertDate(stringDate) ?? new Date();
      } catch (error) {}

      try {
        lessonUrl = await page.$eval(
          `link[rel=canonical][href*=meirtv]`,
          (elm) => elm["href"].split("/")
        );
        id = lessonUrl[lessonUrl.length - 2];
      } catch (error) {
        lessonUrl = url;
      }

      const valid = !_.isNil(mp3Url) && !_.isNil(title);
      return {
        date,
        url,
        mediaUrl: mp3Url,
        tags,
        title,
        id,
        updatedAt: new Date(),
        valid,
      };
    });
  }
}

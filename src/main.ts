import { DateTime } from "luxon";
import Mustache from "mustache";
import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  normalizePath,
} from "obsidian";
import {
  Article,
  loadArticles,
  parseDateTime,
  DATE_FORMAT,
  PageType,
  compareHighlightsInFile,
  getHighlightLocation,
} from "./util";

// Remember to rename these classes and interfaces!
enum Filter {
  ALL = "import all my articles",
  HIGHLIGHTS = "import just highlights",
  ADVANCED = "advanced",
}

enum HighlightOrder {
  LOCATION = "the location of highlights in the article",
  TIME = "the time that highlights are updated",
}

interface Settings {
  apiKey: string;
  filter: string;
  syncAt: string;
  customQuery: string;
  highlightOrder: string;
  articleTemplate: string;
  highlightTemplate: string;
  syncing: boolean;
  folder: string;
  dateFormat: string;
  endpoint: string;
}

const DEFAULT_SETTINGS: Settings = {
  apiKey: "",
  filter: "HIGHLIGHTS",
  syncAt: "",
  customQuery: "",
  articleTemplate: `---
{{#author}}
author: {{{author}}}
{{/author}}
{{#labels.length}}
tags:
{{#labels}}  - {{{name}}}
{{/labels}}
{{/labels.length}}
date_saved: {{{dateSaved}}}
---

# {{{title}}}
#Omnivore

[Omnivore Source]({{{omnivoreUrl}}})
[Original Source]({{{originalUrl}}})`,
  highlightTemplate: `> {{{text}}} [⤴️]({{{highlightUrl}}})
{{#note}}

{{{note}}}
{{/note}}`,
  highlightOrder: "TIME",
  syncing: false,
  folder: "Omnivore",
  dateFormat: "yyyy-MM-dd",
  endpoint: "https://api-prod.omnivore.app/api/graphql",
};

export default class OmnivorePlugin extends Plugin {
  settings: Settings;

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: "obsidian-omnivore-sync",
      name: "Sync Omnivore data",
      callback: () => {
        this.fetchOmnivore();
      },
    });

    // This adds a settings tab so the user can configure various aspects of the plugin
    this.addSettingTab(new OmnivoreSettingTab(this.app, this));
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async fetchOmnivore() {
    const {
      syncAt,
      apiKey,
      filter,
      customQuery,
      highlightOrder,
      syncing,
      articleTemplate,
      highlightTemplate,
      folder,
    } = this.settings;

    if (syncing) return;

    if (!apiKey) {
      new Notice("Missing Omnivore api key");

      return;
    }

    this.settings.syncing = true;
    await this.saveSettings();

    const folderName = folder || "Omnivore";
    if (!(await this.app.vault.adapter.exists(normalizePath(folderName)))) {
      await this.app.vault.createFolder(folderName);
    }

    try {
      console.log(`obsidian-omnivore starting sync since: '${syncAt}`);

      new Notice("🚀 Fetching articles ...");

      const size = 50;
      for (
        let hasNextPage = true, articles: Article[] = [], after = 0;
        hasNextPage;
        after += size
      ) {
        [articles, hasNextPage] = await loadArticles(
          this.settings.endpoint,
          apiKey,
          after,
          size,
          parseDateTime(syncAt).toISO(),
          this.getQueryFromFilter(filter, customQuery)
        );

        for (const article of articles) {
          const pageName = `${folderName}/${article.slug}.md`;
          const siteName =
            article.siteName ||
            this.siteNameFromUrl(article.originalArticleUrl);
          const dateSaved = DateTime.fromISO(article.savedAt).toFormat(
            this.settings.dateFormat
          );
          // Build content string based on template
          let content = Mustache.render(articleTemplate, {
            title: article.title,
            omnivoreUrl: `https://omnivore.app/me/${article.slug}`,
            siteName,
            originalUrl: article.originalArticleUrl,
            author: article.author,
            labels: article.labels?.map((l) => {
              return {
                name: l.name.replace(" ", "_"),
              };
            }),
            dateSaved,
          });

          // sort highlights by location if selected in options
          highlightOrder === "LOCATION" &&
            article.highlights?.sort((a, b) => {
              try {
                if (article.pageType === PageType.File) {
                  // sort by location in file
                  return compareHighlightsInFile(a, b);
                }
                // for web page, sort by location in the page
                return (
                  getHighlightLocation(a.patch) - getHighlightLocation(b.patch)
                );
              } catch (e) {
                console.error(e);
                return compareHighlightsInFile(a, b);
              }
            });

          content += "\n\n";

          if (article.highlights && article.highlights.length > 0) {
            content += "## Highlights\n\n";

            for (const highlight of article.highlights) {
              const highlightContent = Mustache.render(highlightTemplate, {
                text: highlight.quote.replace(/\n/g, "\n> "),
                highlightUrl: `https://omnivore.app/me/${article.slug}#${highlight.id}`,
                dateHighlighted: new Date(highlight.updatedAt).toString(),
                note: highlight.annotation,
              });

              content += `${highlightContent}\n`;
            }
          }

          await this.app.vault.adapter.write(normalizePath(pageName), content);
        }
      }

      new Notice("🔖 Articles fetched");
      this.settings.syncAt = DateTime.local().toFormat(DATE_FORMAT);
    } catch (e) {
      new Notice("Failed to fetch articles");
      console.error(e);
    } finally {
      this.settings.syncing = false;
      await this.saveSettings();
    }
  }

  getQueryFromFilter(filter: string, customQuery: string): string {
    switch (filter) {
      case "ALL":
        return "";
      case "HIGHLIGHTS":
        return `has:highlights`;
      case "ADVANCED":
        return customQuery;
      default:
        return "";
    }
  }

  siteNameFromUrl(originalArticleUrl: string): string {
    try {
      return new URL(originalArticleUrl).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  }
}

class OmnivoreSettingTab extends PluginSettingTab {
  plugin: OmnivorePlugin;

  private static createFragmentWithHTML = (html: string) =>
    createFragment(
      (documentFragment) => (documentFragment.createDiv().innerHTML = html)
    );

  constructor(app: App, plugin: OmnivorePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    containerEl.createEl("h2", { text: "Settings for omnivore plugin" });

    containerEl.createEl("h3", { text: "General Settings" });

    new Setting(containerEl)
      .setName("API Key")
      .setDesc("You can create an API key at https://omnivore.app/settings/api")
      .addText((text) =>
        text
          .setPlaceholder("Enter your Omnivore Api Key")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            console.log("apiKey: " + value);
            this.plugin.settings.apiKey = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Filter")
      .setDesc("Select an Omnivore search filter type")
      .addDropdown((dropdown) => {
        dropdown.addOptions(Filter);
        dropdown
          .setValue(this.plugin.settings.filter)
          .onChange(async (value) => {
            console.log("filter: " + value);
            this.plugin.settings.filter = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Custom query")
      .setDesc(
        "See https://omnivore.app/help/search for more info on search query syntax"
      )
      .addText((text) =>
        text
          .setPlaceholder(
            "Enter an Omnivore custom search query if advanced filter is selected"
          )
          .setValue(this.plugin.settings.customQuery)
          .onChange(async (value) => {
            console.log("query: " + value);
            this.plugin.settings.customQuery = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Last Sync")
      .setDesc("Last time the plugin synced with Omnivore")
      .addMomentFormat((momentFormat) =>
        momentFormat
          .setPlaceholder("Last Sync")
          .setValue(this.plugin.settings.syncAt)
          .setDefaultFormat("yyyy-MM-dd'T'HH:mm:ss")
          .onChange(async (value) => {
            console.log("syncAt: " + value);
            this.plugin.settings.syncAt = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Highlight Order")
      .setDesc("Select the order in which highlights are applied")
      .addDropdown((dropdown) => {
        dropdown.addOptions(HighlightOrder);
        dropdown
          .setValue(this.plugin.settings.highlightOrder)
          .onChange(async (value) => {
            console.log("highlightOrder: " + value);
            this.plugin.settings.highlightOrder = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Article Template")
      .setDesc(
        OmnivoreSettingTab.createFragmentWithHTML(
          `Enter the template for the article. <a href="https://github.com/janl/mustache.js/#templates">Link to reference</a>`
        )
      )
      .addTextArea((text) =>
        text
          .setPlaceholder("Enter the article template")
          .setValue(this.plugin.settings.articleTemplate)
          .onChange(async (value) => {
            console.log("articleTemplate: " + value);
            this.plugin.settings.articleTemplate = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Highlight Template")
      .setDesc(
        OmnivoreSettingTab.createFragmentWithHTML(
          `Enter the template for the highlight. <a href="https://github.com/janl/mustache.js/#templates">Link to reference</a>`
        )
      )
      .addTextArea((text) =>
        text
          .setPlaceholder("Enter the highlight template")
          .setValue(this.plugin.settings.highlightTemplate)
          .onChange(async (value) => {
            console.log("highlightTemplate: " + value);
            this.plugin.settings.highlightTemplate = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Folder")
      .setDesc("Enter the folder where the data will be stored")
      .addText((text) =>
        text
          .setPlaceholder("Enter the folder")
          .setValue(this.plugin.settings.folder)
          .onChange(async (value) => {
            console.log("folder: " + value);
            this.plugin.settings.folder = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Date Format")
      .setDesc(
        OmnivoreSettingTab.createFragmentWithHTML(
          'Enter the format date for use in rendered template.\nFormat <a href="https://moment.github.io/luxon/#/formatting?id=table-of-tokens">reference</a>.'
        )
      )
      .addText((text) =>
        text
          .setPlaceholder("Date Format")
          .setValue(this.plugin.settings.dateFormat)
          .onChange(async (value) => {
            this.plugin.settings.dateFormat = value;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h3", { text: "Advanced Settings" });

    new Setting(containerEl)
      .setName("API Endpoint")
      .setDesc("Enter the Omnivore server's API endpoint")
      .addText((text) =>
        text
          .setPlaceholder("API endpoint")
          .setValue(this.plugin.settings.endpoint)
          .onChange(async (value) => {
            console.log("endpoint: " + value);
            this.plugin.settings.endpoint = value;
            await this.plugin.saveSettings();
          })
      );
  }
}

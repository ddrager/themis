import { Injectable, BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Post } from '../entities/post.entity';
import { CreatePostDto } from '../dtos/create-post.dto';
import { ConfigService } from '../config/config.service';
import * as uuidv5 from 'uuid/v5';
import * as URI from 'uri-js';
import { User } from '../entities/user.entity';
import { UserService } from '../user/user.service';
import { GroupService } from '../group/group.service';
import { CreateTopLevelPostDto } from '../dtos/create-top-level-post.dto';
import { CreateReplyDto } from '../dtos/create-reply.dto';
import { Group } from '../entities/group.entity';
import { CreateGlobalPostDto } from '../dtos/create-global-post.dto';
import { Actor } from '../activitypub/definitions/actor.interface';
import { ServerService } from '../server/server.service';

/**
 * Anything dealing with posts eventually ends up in this service.
 * Here is where we handle the basic CRUD operations, all the
 * various searches (including the tree operations we need to deal
 * with the threaded nature of Themis posting), and so on.
 *
 * @export
 * @class PostService
 */
@Injectable()
export class PostService {
    constructor(
        @InjectRepository(Post)
        private readonly postRepository: Repository<Post>,
        private readonly configService: ConfigService,
        private readonly userService: UserService,
        private readonly groupService: GroupService,
        private readonly serverService: ServerService
    ) {}

    /**
     * Create a new post. This method will not be called in response to
     * a received ActivityPub activity.
     *
     * @param post A DTO containing the post's content and metadata
     * @returns The database entity for the new post
     * @memberof PostService
     */
    async create(post: CreatePostDto): Promise<Post> {
        const postedGroupNames: string[] = [post.primaryGroup].concat(post.ccGroups);
        const postedGroups: Group[] = await Promise.all(postedGroupNames.map(
            (e) => this.groupService.findByName(e)
        ));

        const hostname = this.serverService.parseHostname(post.server);
        const server = (await this.serverService.findOrCreate(hostname)) ||
        (await this.serverService.local());

        const postEntity = this.postRepository.create({
            uuid: this.createNewUuid(post.subject + post.content + post.sender),
            sender: await this.userService.findByName(post.sender),
            server: server,
            subject: post.subject,
            parentUri: post.parent,
            groups: postedGroups,
            content: post.content,
            source: post.source
        });

        return await this.postRepository.save(postEntity);
    }

    /**
     * Create a new post from an AP Create activity. This uses the "global"
     * post type, since there's no guarantee that the post originated on
     * our server.
     *
     * @param post A post object, including all metadata
     * @returns The newly-created database entity representing the post
     * @memberof PostService
     */
    async createFromActivity(post: CreateGlobalPostDto): Promise<Post> {
        const senderEntity = await this.findOrCreateUser(post.sender);
        const hostname = this.serverService.parseHostname(post.sender.server);
        const server = (await this.serverService.findOrCreate(hostname)) ||
        (await this.serverService.local());

        const targetGroupEntities = await Promise.all(post.groups.map((g) =>
            this.findOrCreateGroup(g)));

        const uuid = this.createNewUuid(post.sender + post.content);
        const entity = this.postRepository.create({
            sender: senderEntity,
            server: server,
            groups: targetGroupEntities,
            subject: post.subject,
            content: post.content,
            source: post.source || null,

            uri: post.id || this.uriFromUuid(uuid),
            parentUri: post.parent || '',

            uuid: uuid,
            timestamp: (new Date()).toJSON(),
            deleted: false,
        });

        if (post.parent) {
            entity.parent = await this.findByUri(post.parent);
        }

        return this.postRepository.save(entity);
    }

    /**
     * Find the database entry for a given user. If none exists,
     * then create a new one and return it.
     *
     * @param user The name and server of the user
     * @returns The database entity representing the user, possibly new
     * @memberof PostService
     */
    async findOrCreateUser(user: Actor): Promise<User> {
        try {
            const entity = await this.userService.findGlobalByName(
                user.name, user.server);
            
            // If this user already exists, return the entity
            return entity;
        } catch (e) {
            // Find promise was rejected, meaning that the user
            // doesn't exist in our DB yet. So we need to create
            // a new entry for it.

            // TODO: Handle fetching data, like avatars, etc.
            return this.userService.create({
                name: user.name,
                server: user.server,
                displayName: user.name,
                summary: '',
                iconUrl: ''
            });
        }
    }

    /**
     * Find the database entry for a given group. If none exists,
     * then create a new one and return it.
     *
     * @param group The name and server of the group to find
     * @returns The database entity representing the group
     * @memberof PostService
     */
    async findOrCreateGroup(group: Actor): Promise<Group> {
        try {
            const entity = await this.groupService.findGlobalByName(
                group.name, group.server);
            
            // If this group exists, return the entity
            return entity;
        } catch (e) {
            // Find promise was rejected, meaning that the group
            // doesn't exist in our DB yet. So we need to create
            // a new entry for it.

            // TODO: Handle fetching metadata
            return this.groupService.create({
                name: group.name,
                server: group.server,
                displayName: group.name,
                summary: ''
            });
        }
    }

    /**
     * Create a new top-level (parent-less) post.
     *
     * @param post A DTO containing the post's content and metadata
     * @returns The resulting post entity
     * @memberof PostService
     */
    async createTopLevel(post: CreateTopLevelPostDto): Promise<Post> {
        const postEntity = await this.createPostEntity(post);

        return this.postRepository.save(postEntity);
    }

    /**
     * Create a reply to the post with the given UUID.
     *
     * @param post A DTO for the reply's content and metadata
     * @param parent The URI of the reply's parent post
     * @returns The entity for the reply
     * @memberof PostService
     */
    async createReply(post: CreateReplyDto, parent: string): Promise<Post> {
        const user = await this.userService.findByName(post.sender);
        const parentPost = await this.postRepository.findOne({ uuid: parent });

        if (!parentPost) {
            // The given UUID isn't a valid post, which usually means something's wrong
            // TODO: Handle the error
            throw new BadRequestException();
        }

        // TODO: Handle crossposting
        const postedGroups = await this.groupService.findByIds([post.group]);

        const postEntity = await this.createPostEntity(post);
        postEntity.parent = parentPost;

        return this.postRepository.save(postEntity);
    }

    /**
     * Delete a post from the database. This is different from deleting
     * it from groups or the server. This method is instead a "hard"
     * delete; higher levels will issue the appropriate status codes
     * when someone attempts to retrieve this post.
     *
     * @param uuid The UUID of the post (which can be obtained from the URI)
     * @returns The post entity, now deleted from the DB
     * @memberof PostService
     */
    async delete(uuid: string): Promise<Post> {
        const post = await this.postRepository.findOne({ uuid: uuid });

        return await this.postRepository.remove(post);
    }

    /**
     * Update a post's database entry
     *
     * @param post The post entity, with updated fields
     * @returns The updated post, after it has been saved to the DB
     * @memberof PostService
     */
    async update(post: Post): Promise<Post> {
        return this.postRepository.save(post);
    }

    /**
     * Get all the posts this server knows about. Warning: this can
     * be a huge amount of data, as Themis stores both local posts
     * and those it receives in federation.
     *
     * @returns An array of all posts stored in the database
     * @memberof PostService
     */
    async findAll(): Promise<Post[]> {
        return await this.postRepository.find();
    }

    /**
     * Get the post with a given ID.
     *
     * @param id The ID of a post this server knows about
     * @returns The post with that ID
     * @memberof PostService
     */
    async find(id: number): Promise<Post> {
        return await this.postRepository.findOne(id);
    }

    /**
     * Get a count of all posts on this server.
     *
     * @returns The total number of posts this server knows about
     * @memberof PostService
     */
    async countLocal(): Promise<number> {
        return this.postRepository.count({ server: await this.serverService.local() });
    }

    /**
     * Get a post given its UUID. These are auto-generated by
     * the server, and not presently made to be ordered in any
     * sense. (That may change in the future.)
     *
     * @param uuid The UUID of a post
     * @returns The post, if it exists and is known by this server
     * @memberof PostService
     */
    async findByUuid(uuid: string): Promise<Post> {
        const postEntity = await this.postRepository.findOne({
            where: { uuid },
            relations: ['children']
        });

        const treeRepository = this.postRepository.manager.getTreeRepository(Post)

        if (postEntity.children.length) {
            const response = await this.loadRelations(await treeRepository.findDescendantsTree(postEntity));

            return response;
        } else {
            return postEntity;
        }
    }

    /**
     * Find a post given its URI. Since these include UUIDs,
     * and those are unique by definition, this should work.
     *
     * @param uri The URI of the post
     * @returns The post as a DB entity
     * @memberof PostService
     */
    async findByUri(uri: string): Promise<Post> {
        return this.postRepository.findOneOrFail({uri});
    }

    /**
     * Get all posts made by a certain user.
     *
     * @param id The database ID of the user
     * @returns An array of post entities authored by that user
     * @memberof PostService
     */
    async findByUserId(id: number): Promise<Post[]> {
        const response = await this.postRepository
            .createQueryBuilder("post")
            .leftJoinAndSelect("post.groups", "groups")
            .leftJoinAndSelect("post.sender", "sender")
            .where("sender.id = :id", { id })
            .getMany();

        return response;
    }

    /**
     * Get all posts in a given group. This returns a flat list,
     * not a tree structure, so it is not appropriate if threading
     * needs to be maintained.
     *
     * @param group The name of a group on this server
     * @returns An array of post entities posted in that group
     * @memberof PostService
     */
    async findByGroup(group: string): Promise<Post[]> {
        const groupEntity = await this.groupService.findByName(group);

        const response = await this.postRepository
            .createQueryBuilder("post")
            // .leftJoinAndSelect("post.groups", "groups")
            // .leftJoinAndSelect("post.sender", "sender")
            .where("groups.id = :id", { id: groupEntity.id })
            .getMany();

        return response;
    }

    /**
     * Get all posts in the group with a given ID. This can
     * find "foreign" groups as well as local ones. The data
     * is returned as a flat list, not a tree structure.
     *
     * @param id The ID of a group
     * @returns An array of post entities for that group
     * @memberof PostService
     */
    async findByGroupId(id: number): Promise<Post[]> {
        const response = await this.postRepository
            .createQueryBuilder("post")
            .leftJoinAndSelect("post.groups", "groups")
            .leftJoinAndSelect("post.sender", "sender")
            .leftJoinAndSelect("post.server", "server")
            .where("groups.id = :id", { id })
            .getMany();

        return response;
    }

    /**
     * Get all the top-level posts in a given group. These
     * are the posts with no parent, thus sitting at the
     * top of a thread.
     *
     * @param group The name of a group on this server
     * @returns An array of post entities
     * @memberof PostService
     */
    async findTopLevelByGroup(group: string): Promise<Post[]> {
        const groupEntity = await this.groupService.findByName(group);

        const response = await this.postRepository
            .createQueryBuilder("post")
            // .leftJoinAndSelect("post.groups", "groups")
            // .leftJoinAndSelect("post.sender", "sender")
            // .leftJoinAndSelect("post.parent", "parent")
            .where("groups.id = :id", { id: groupEntity.id })
            .andWhere("post.parentId is null")
            .getMany();

        return response;
    }

    /**
     * Get a count of a post's children.
     *
     * @param id The ID of a post
     * @returns The number of children of that post
     * @memberof PostService
     */
    async countChildren(id: number): Promise<number> {
        const treeRepository = this.postRepository.manager.getTreeRepository(Post);
        const post = await this.find(id);

        // TypeORM counts the root entity as a descendant
        // for some strange reason, so -1 to account for that.
        return (await treeRepository.countDescendants(post)) - 1;
    }

    /**
     * Get the children of a post. This works recursively,
     * following the tree structure of a Themis thread or
     * subthread.
     *
     * @param id The ID of a post
     * @returns An array containing that post's children; the `children`
     * property of each child allows further descent
     * @memberof PostService
     */
    async findChildren(id: number): Promise<Post[]> {
        const treeRepository = this.postRepository.manager.getTreeRepository(Post);
        const parent = await this.find(id);

        const withChildren = await this.postRepository.find({
            parent
        })

        // const withChildren = await treeRepository.findDescendantsTree(parent);
        // const withChildren = treeRepository
        //     .createDescendantsQueryBuilder('post', 'postClosure', parent)
        //     .leftJoinAndSelect('post.sender', 'sender')
        //     .leftJoinAndSelect('post.groups', 'groups')
        //     .leftJoinAndSelect('post.server', 'server')
        //     .getMany();
        // const withChildren = await this.loadRelations(parent);

        return withChildren;
    }

    async countChildrenOld(parent: Post): Promise<number> {
        const treeRepository = this.postRepository.manager.getTreeRepository(Post);

        return treeRepository.countDescendants(parent);
    }

    async findChildrenOld(parent: Post): Promise<Post> {
        const treeRepository = this.postRepository.manager.getTreeRepository(Post);

        const response = await treeRepository.findDescendantsTree(parent);

        return response;
    }

    /**
     * Get the direct replies for a post.
     *
     * @param parent The parent post
     * @returns An array containing all direct children, if any
     * @memberof PostService
     */
    async getReplies(parent: Post): Promise<Post[]> {
        const treeRepository = this.postRepository.manager.getTreeRepository(Post);

        const filled = await treeRepository.findDescendantsTree(parent);

        const children = Promise.all(filled.children.map((c) => this.find(c.id)));
        return children;
    }

    /**
     * Get the direct parent of a post
     *
     * @param child The post whose parent is needed
     * @returns The parent post, or undefined if the given post is top-level
     * @memberof PostService
     */
    async getParent(child: Post): Promise<Post | undefined> {
        const treeRepository = this.postRepository.manager.getTreeRepository(Post);

        const filled = await treeRepository.findAncestorsTree(child);

        return filled.parent || undefined;
    }

    /**
     * Performs a "soft" delete of a post. This does not remove the post
     * from the database. Instead, it sets the "deleted" flag, which will
     * cause accesses to return a 410 Gone status code.
     *
     * @param post The post to delete
     * @returns The post, now with the deleted flag set
     * @memberof PostService
     */
    async softDelete(post: Post): Promise<Post> {
        if (await this.isLocalPost(post)) {
            post.deleted = true;
            return this.postRepository.save(post);
        } else {
            // We can't delete posts that aren't our own.
            throw new BadRequestException("Can't delete a non-local post");
        }
    }

    /**
     * Get the URI of a local post. In most cases, this is
     * stored in the DB, but there may be cases where that
     * doesn't happen, so we need to generate it.
     *
     * @param post The post entity
     * @returns The URI for that post
     * @memberof PostService
     */
    async uriFromLocalPost(post: Post): Promise<string> {
        if (post.uri) {
            // We already have a URI, so just return that
            return post.uri;
        } else if (await this.isLocalPost(post)) {
            // It's a local post, so we can make a URI
            return this.uriFromUuid(post.uuid);
        } else {
            // We don't really know what to do
            throw new Error(`No URI found for post ${post.uuid}`);
        }
    }

    /**
     * Create a post URI given the post's UUID. This is only
     * needed for local posts, as incoming posts from other
     * servers will already have a URI.
     *
     * @param uuid The post's UUID
     * @returns The URI for the post
     * @memberof PostService
     */
    uriFromUuid(uuid: string): string {
        const host = this.configService.serverAddress;
        const port = this.configService.serverPort;
        const scheme = this.configService.isHttps ? 'https' : 'http';

        const uri = URI.serialize({
            host,
            port,
            scheme,
            path: `/post/${uuid}`
        });

        return uri;
    }

    /**
     * Create a new UUID for a post. This uses the server's
     * hostname or IP address, as defined in the configuration
     * settings.
     *
     * @param data The data of a post
     * @returns A UUID
     * @memberof PostService
     */
    createNewUuid(data: any): string {
        const server = this.configService.serverAddress;
        const namespace = uuidv5(server, uuidv5.DNS);

        return uuidv5(Date.now().toString() + data.toString(), namespace);
    }

    /**
     * Create a database entity for a post.
     *
     * @private
     * @param post An object contaiing the content and metadata for a post
     * @returns The post entity
     * @memberof PostService
     */
    private async createPostEntity(post: any): Promise<Post> {
        const user = await this.userService.findByName(post.sender);

        // TODO: Handle crossposting
        const postedGroups = await this.groupService.findByIds([post.group]);

        const postEntity = new Post();

        postEntity.sender = user;
        postEntity.groups = postedGroups;
        postEntity.subject = post.subject;
        postEntity.content = post.body;

        postEntity.parentUri = '';
        postEntity.timestamp = (new Date()).toJSON();
        // TODO: Handle federation
        postEntity.server = await this.serverService.local();

        postEntity.uuid = this.createNewUuid(post.subject + post.body + post.sender);
        postEntity.uri = await this.uriFromLocalPost(postEntity);

        // TODO: Handle post deletion, tombstones, etc.
        postEntity.deleted = false;

        return postEntity;
    }

    /**
     * Load the child relations of a post's database entity.
     * We need this helper method because TypeORM doesn't seem to support
     * loading relations for child nodes in a tree structure.
     * 
     * @private
     * @param root The post
     * @returns The same post, but with its children loaded into the `children` property
     * @memberof PostService
     */
    private async loadRelations(root: Post): Promise<Post> {
        const result = await this.postRepository.findOne(root.id, {relations : ['children'] });

        if (result.children) {
            result.children = await Promise.all(result.children.map(c => this.loadRelations(c)))
        }

        return result;
    }

    /**
     * Returns whether this post originated on this server.
     *
     * @private
     * @param post A post
     * @returns Whether the post's origin is this server
     * @memberof PostService
     */
    private async isLocalPost(post: Post): Promise<boolean> {
        const local = await this.serverService.local();
        return (
            local.host === post.server.host 
            && local.scheme === post.server.scheme
            && (local.port === post.server.port || post.server.port === undefined)
        )
    }
}
